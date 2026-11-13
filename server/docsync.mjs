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

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

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

function save(list) {
  writeFileSync(file(), JSON.stringify(list, null, 2), "utf8");
}

function nextId(list) {
  const max = list.reduce((m, x) => Math.max(m, Number(String(x.id).replace(/\D/g, "")) || 0), 0);
  return "d" + (max + 1);
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

// 入队：一条任务对应一条文档同步（写一行「开发中」）
export function enqueue({ taskId, subject, priority, status = "开发中", note = "", docUrl } = {}) {
  const list = loadQueue();
  reclaimStale(list);
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
  save(list);
  return it;
}

// 取活：拿一条 pending，标 running 并 +1 次数
export function nextJob() {
  const list = loadQueue();
  const changed = reclaimStale(list);
  const it = list.find((x) => x.status === "pending");
  if (!it) {
    if (changed) save(list);
    return null;
  }
  it.status = "running";
  it.attempts = (Number(it.attempts) || 0) + 1;
  it.startedAt = Date.now();
  it.updatedAt = Date.now();
  save(list);
  return it;
}

// 回调：done / failed（失败且还有额度就退回 pending，等下一轮）
export function report({ id, status, evidence = "" } = {}) {
  const list = loadQueue();
  const it = list.find((x) => String(x.id) === String(id));
  if (!it) throw new Error("没有这条文档同步: " + id);
  if (!["done", "failed"].includes(status)) throw new Error("status 只能是 done / failed");
  it.updatedAt = Date.now();
  if (status === "done") {
    it.status = "done";
    it.evidence = String(evidence || "");
    it.lastError = "";
    it.doneAt = Date.now();
  } else {
    it.lastError = String(evidence || "未给原因");
    it.evidence = "";
    if ((Number(it.attempts) || 0) >= MAX_ATTEMPTS) {
      it.status = "failed";
    } else {
      it.status = "pending";
    }
  }
  save(list);
  if (status === "done") markTaskSynced(it.taskId);
  return it;
}

// 回调成功就顺手把任务表里的这一条标成「台账已同步」，面板进度条靠它推进
function markTaskSynced(taskId) {
  if (!taskId) return;
  try {
    const tf = join(PATHS.dataDir, "Vesta.tasks.json");
    if (!existsSync(tf)) return;
    const tasks = JSON.parse(readFileSync(tf, "utf8"));
    const t = tasks.find((x) => String(x.id) === String(taskId));
    if (!t) return;
    t.docSyncedAt = Date.now();
    t.updatedAt = Date.now();
    writeFileSync(tf, JSON.stringify(tasks, null, 2), "utf8");
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
