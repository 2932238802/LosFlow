// docsync.mjs -- 腾讯文档任务表的「异步同步」队列。
//
// 为什么要它：任务推入后，工作 Agent（Claude Code）应当立刻能开工，
// 不该等 WorkBuddy 把那一行写进腾讯文档。于是把「写文档」拆成一条独立的
// 异步任务放进这个队列，WorkBuddy 有空来取（next_docsync）再写，写完回调。
//
// 文件：<progressDir>\docsync.json
// 状态：pending -> running -> done
//                       \-> pending（失败重试，最多 MAX_ATTEMPTS 次）-> failed
//
// 超时回收：running 超过 STALE_MS 视为卡死，退回 pending 让别人再取。

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mutate } from "./store.mjs";

export const DEFAULT_DOC =
  "https://docs.qq.com/sheet/DZVFSeURwdmVJdVZL?tab=BB08J2";

const MAX_ATTEMPTS = 3;
const STALE_MS = 15 * 60 * 1000;

let PATHS = null;
export function initDocsync(paths) {
  PATHS = paths;
}

const file = () => join(PATHS.dataDir, "docsync.json");

export function loadQueue() {
  try {
    if (!existsSync(file())) return [];
    const raw = JSON.parse(readFileSync(file(), "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function nextId(list) {
  const max = list.reduce((m, x) => Math.max(m, Number(String(x.id).replace(/\D/g, "")) || 0), 0);
  return "d" + (max + 1);
}

// 判定一段文字是不是「写腾讯文档」的活。
//
// 写表格是默认后台行为：只走本队列 → WorkBuddy，不建任务、不进任务池、不进终端、
// 不派给 Claude Code。新建任务入口（taskboard.ps1 -Add / wb-bridge add_task）
// 用这个判定从源头拦住；服务端派单前也用它兜底。
const DOC_URL_RE = /docs\.qq\.com/i;
const DOC_WRITE_RE = /append-row|update-row|整理(?:腾讯文档)?主表|腾讯文档任务表/i;
const DOC_ACTION_RE = /(追加|新增|写入|补写|整理|归档|移(?:到|入|出|至))/;
export function isDocSyncInstruction(text) {
  const s = String(text || "");
  if (!s) return false;
  // 明确的队列动作词，不看 URL 也算文档活
  if (DOC_WRITE_RE.test(s)) return true;
  // 给了腾讯文档地址，又带着「写」的动作，就是文档同步指令
  return DOC_URL_RE.test(s) && DOC_ACTION_RE.test(s);
}

function reclaimStale(list) {
  const now = Date.now();
  let changed = false;
  for (const it of list) {
    if (it.status === "running" && it.startedAt && now - it.startedAt > STALE_MS) {
      it.status = "pending";
      it.lastError = "取走 15 分钟未回执，已退回队列";
      it.updatedAt = now;
      changed = true;
    }
  }
  return changed;
}

// 读-改-写全部在 mutate 回调里完成：并发入队（推入时 Promise.all）不会互相覆盖。
async function updateQueue(fn) {
  let out = null;
  await mutate(file(), (cur) => {
    const list = Array.isArray(cur) ? cur : [];
    reclaimStale(list);
    out = fn(list);
    return list;
  });
  return out;
}

// 入队：一条任务对应一条文档同步（写一行「开发中」）
export function enqueue({ taskId, subject, priority, status = "开发中", note = "", docUrl } = {}) {
  return updateQueue((list) => {
    const now = Date.now();
    const it = {
      id: nextId(list),
      taskId: String(taskId || ""),
      action: "append-row",
      docUrl: docUrl || DEFAULT_DOC,
      payload: { subject: String(subject || ""), priority: priority || "中", status, note: String(note || "") },
      status: "pending",
      attempts: 0,
      lastError: "",
      createdAt: now,
      updatedAt: now,
    };
    list.push(it);
    return it;
  });
}

// 入队：回填一条任务（人在终端里标完成 → 类型 + 区域）
// action=update-row：WorkBuddy 在主表里按任务名找到那一行，只改状态与备注；
// 找不到（推入时那行还没写进去）就按 append-row 追加，不会丢。
export function enqueueBackfill({ taskId, subject, workType, area } = {}) {
  const typeLabel = { dev: "开发", review: "review", plan: "Plan" }[workType] || String(workType || "开发");
  const kind = area && area.kind === "docs" ? "文档区" : "代码区";
  const path = String((area && area.path) || "").trim();
  const payload = {
    subject: String(subject || ""),
    status: "已完成",
    priority: "",
    note: `类型：${typeLabel}；区域：${kind}${path ? " " + path : ""}`,
  };
  return updateQueue((list) => {
    const now = Date.now();
    // 同一条任务已经有排队中的回填 → 覆盖成最新内容，不重复入队
    const exist = list.find(
      (x) => x.action === "update-row" && String(x.taskId) === String(taskId) && ["pending", "running"].includes(x.status)
    );
    if (exist) {
      exist.payload = payload;
      exist.updatedAt = now;
      return exist;
    }
    const it = {
      id: nextId(list),
      taskId: String(taskId || ""),
      action: "update-row",
      docUrl: DEFAULT_DOC,
      payload,
      status: "pending",
      attempts: 0,
      lastError: "",
      createdAt: now,
      updatedAt: now,
    };
    list.push(it);
    return it;
  });
}

// 入队：整理主表（维护动作）。写文档是默认后台行为，不建任务、不进任务池、不派终端。
// taskId 留空：这不是哪条开发任务的同步，WorkBuddy 取到后按 payload.note 独立执行。
export function enqueueMaintenance({ note = "", docUrl } = {}) {
  return updateQueue((list) => {
    const now = Date.now();
    // 已经有一条排队 / 在跑的整理 → 只更新内容，不重复入队（连点按钮也只排一条）
    const exist = list.find((x) => x.action === "cleanup" && ["pending", "running"].includes(x.status));
    if (exist) {
      if (note) exist.payload.note = String(note);
      exist.updatedAt = now;
      return exist;
    }
    const it = {
      id: nextId(list),
      taskId: "",
      action: "cleanup",
      docUrl: docUrl || DEFAULT_DOC,
      payload: { subject: "整理腾讯文档主表", priority: "", status: "", note: String(note || "") },
      status: "pending",
      attempts: 0,
      lastError: "",
      createdAt: now,
      updatedAt: now,
    };
    list.push(it);
    return it;
  });
}

// 取活：拿一条 pending，标 running 并 +1 次数
export function nextJob() {
  return updateQueue((list) => {
    const it = list.find((x) => x.status === "pending");
    if (!it) return null;
    it.status = "running";
    it.attempts = (Number(it.attempts) || 0) + 1;
    it.startedAt = Date.now();
    it.updatedAt = Date.now();
    return it;
  });
}

// 回调：done / failed（失败且还有额度就退回 pending，等下一轮）
export function report({ id, status, evidence = "" } = {}) {
  if (!["done", "failed"].includes(status)) return Promise.reject(new Error("status 只能是 done / failed"));
  return updateQueue((list) => {
    const it = list.find((x) => String(x.id) === String(id));
    if (!it) throw new Error("没有这条文档同步: " + id);
    it.updatedAt = Date.now();
    if (status === "done") {
      it.status = "done";
      it.evidence = String(evidence || "");
      it.lastError = "";
      it.doneAt = Date.now();
    } else {
      it.lastError = String(evidence || "未给原因");
      it.evidence = "";
      it.status = (Number(it.attempts) || 0) >= MAX_ATTEMPTS ? "failed" : "pending";
    }
    return it;
  }).then(async (it) => {
    if (status === "done") await markTaskSynced(it.taskId);
    return it;
  });
}

// 回调成功就顺手把任务表里的这一条标成「台账已同步」，面板进度条靠它推进
async function markTaskSynced(taskId) {
  if (!taskId) return;
  try {
    const tf = join(PATHS.dataDir, "Vesta.tasks.json");
    if (!existsSync(tf)) return;
    await mutate(tf, (tasks) => {
      const list = Array.isArray(tasks) ? tasks : [];
      const t = list.find((x) => String(x.id) === String(taskId));
      if (!t) return list;
      t.docSyncedAt = Date.now();
      t.updatedAt = Date.now();
      return list;
    });
  } catch {
    /* 任务表写不进去不影响同步结果 */
  }
}
export function summary() {
  const list = loadQueue();
  const byTask = {};
  for (const it of list) {
    const k = String(it.taskId || "");
    if (!k) continue;
    byTask[k] = {
      id: it.id,
      status: it.status,
      attempts: it.attempts || 0,
      error: it.lastError || "",
      updatedAt: it.updatedAt || null,
      doneAt: it.doneAt || null,
    };
  }
  const count = (s) => list.filter((x) => x.status === s).length;
  return {
    pending: count("pending"),
    running: count("running"),
    done: count("done"),
    failed: count("failed"),
    byTask,
    recent: list.slice(-20).reverse(),
  };
}
