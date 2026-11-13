// docsync.mjs -- 文档同步队列（连接器版，13 号方案）。
//
// 队列文件：<dataDir>/docsync.json
//   job = { id, connector, connectorKind, action, payload, targetSnapshot,
//           mappingSnapshot, queue, taskId, status, attempts, lastError,
//           evidence, createdAt, updatedAt, startedAt, doneAt }
//
// executor 连接器：WorkBuddy 通过 MCP next_docsync 取活，report_docsync 回执；
// direct 连接器：本进程直接执行（local-file / http-webhook），失败按连接器
// 的 maxAttempts 重试，状态同样落在这个队列里，可人工重放。
//
// 一条动作会 fan-out 到所有启用且声明了该 action 的连接器；各 job 独立重试。

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mutate } from "./store.mjs";
import * as connectors from "./connector-host.mjs";

const ACTIONS = ["append-row", "update-row", "cleanup", "probe"];
const FALLBACK_MAX_ATTEMPTS = 3;
const FALLBACK_STALE_MS = 15 * 60 * 1000;

let PATHS = null;
let worker = null;
const scheduled = new Set();

export function initDocsync(paths, opts = {}) {
  PATHS = paths;
  migrate();
  // wb-bridge 只消费 executor 队列，不能再起一个 direct worker（会双写）
  if (opts.worker !== false) startWorker();
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

// 判定一段文字是不是「文档活」。连接器被关闭时仍按 manifest 兜底，
// 避免把腾讯文档指令当普通任务派给 Claude Code；host 未初始化（如 CLI/单测）
// 时退回旧正则，保证行为不反转。
const LEGACY_DOC_URL_RE = /docs\.qq\.com/i;
const LEGACY_DOC_WRITE_RE = /append-row|update-row|整理(?:腾讯文档)?主表|腾讯文档任务表/i;
const LEGACY_DOC_ACTION_RE = /(追加|新增|写入|补写|整理|归档|移(?:到|入|出|至))/;
function legacyDocMatch(text) {
  const s = String(text || "");
  if (!s) return false;
  if (LEGACY_DOC_WRITE_RE.test(s)) return true;
  return LEGACY_DOC_URL_RE.test(s) && LEGACY_DOC_ACTION_RE.test(s);
}
export function isDocSyncInstruction(text) {
  return connectors.matchDocInstruction(text) || legacyDocMatch(text);
}

function jobMaxAttempts(job) {
  return Math.max(1, Number(job.queue?.maxAttempts) || FALLBACK_MAX_ATTEMPTS);
}
function jobStaleMs(job) {
  return Math.max(1000, Number(job.queue?.staleMs) || FALLBACK_STALE_MS);
}

function reclaimStale(list) {
  const now = Date.now();
  let changed = false;
  for (const it of list) {
    if (it.status !== "running" || !it.startedAt) continue;
    if (now - Number(it.startedAt) > jobStaleMs(it)) {
      it.status = "pending";
      it.lastError = "取走超时未回执，已退回队列";
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

function newJob(c, action, payload, extra = {}) {
  const now = Date.now();
  const targetSnapshot = { ...(c.config.target || {}), ...(extra.target || {}) };
  return {
    id: extra.id || "",
    connector: c.id,
    connectorKind: c.manifest.kind,
    action,
    taskId: String(extra.taskId || ""),
    payload: payload || {},
    targetSnapshot,
    mappingSnapshot: c.config.mapping || {},
    queue: c.config.queue || {},
    status: "pending",
    attempts: 0,
    lastError: "",
    evidence: "",
    createdAt: now,
    updatedAt: now,
  };
}

function scheduleDirect(id, delay = 0) {
  const key = String(id);
  if (scheduled.has(key)) return;
  scheduled.add(key);
  const timer = setTimeout(() => {
    scheduled.delete(key);
    runDirect(key).catch(() => undefined);
  }, Math.max(0, delay));
  if (timer.unref) timer.unref();
}

async function runDirect(id) {
  const job = loadQueue().find((x) => String(x.id) === String(id));
  if (!job || job.status !== "pending") return;
  const ins = connectors.getConnector(job.connector);
  if (!ins || ins.manifest.kind !== "direct" || typeof ins.impl.write !== "function") return;
  const started = await updateQueue((list) => {
    const it = list.find((x) => String(x.id) === String(id));
    if (!it || it.status !== "pending") return null;
    it.status = "running";
    it.attempts = (Number(it.attempts) || 0) + 1;
    it.startedAt = Date.now();
    it.updatedAt = Date.now();
    return it;
  });
  if (!started) return;
  try {
    const res = await ins.impl.write(started.action, started.payload, {
      target: started.targetSnapshot,
      config: connectors.getConfig(job.connector),
      secret: connectors.getSecret(job.connector),
    });
    await report({ id: started.id, status: "done", evidence: (res && res.evidence) || "" });
    connectors.noteHealth(job.connector, { ok: true, action: started.action, jobId: started.id });
  } catch (e) {
    const out = await report({ id: started.id, status: "failed", evidence: e && e.message ? e.message : String(e) });
    connectors.noteHealth(job.connector, { ok: false, error: e && e.message ? e.message : String(e), action: started.action, jobId: started.id });
    if (out && out.status === "pending") scheduleDirect(id, Math.min(30000, 2000 * (Number(out.attempts) || 1)));
  }
}

async function scanDirect() {
  try {
    await updateQueue((list) => {
      reclaimStale(list);
      return list;
    });
    const list = loadQueue();
    for (const it of list) {
      if (it.status !== "pending") continue;
      const ins = connectors.getConnector(it.connector);
      if (ins && ins.manifest.kind === "direct") scheduleDirect(it.id);
    }
  } catch {
    /* 一轮失败不影响下一轮 */
  }
}

function startWorker() {
  if (worker) return;
  scanDirect();
  worker = setInterval(scanDirect, 15000);
  if (worker.unref) worker.unref();
}

export function stopWorker() {
  if (worker) clearInterval(worker);
  worker = null;
}

// ---- 入队 ----

function payloadOf({ subject, priority, status, note, project }) {
  return {
    subject: String(subject || ""),
    priority: priority || "",
    status: status || "",
    note: String(note || ""),
    project: String(project || ""),
  };
}

// 推入：每个启用且支持 append-row 的连接器各一条
export async function enqueue({ taskId, subject, priority, status = "开发中", note = "", project = "", docUrl } = {}) {
  const targets = connectors.enqueueTargets("append-row");
  if (!targets.length) return [];
  const payload = payloadOf({ subject, priority, status, note, project });
  const jobs = await updateQueue((list) => {
    const made = targets.map((c) => {
      const it = newJob(c, "append-row", payload, { id: nextId(list), taskId, target: docUrl ? { url: docUrl } : {} });
      list.push(it);
      return it;
    });
    return made;
  });
  for (const job of jobs) {
    job.id = job.id || "";
    if (job.connectorKind === "direct") scheduleDirect(job.id);
  }
  return jobs;
}

// 标记完成：每个启用且支持 update-row 的连接器各一条；同一任务已有排队中的回填则覆盖
export async function enqueueBackfill({ taskId, subject, workType, area, project = "" } = {}) {
  const targets = connectors.enqueueTargets("update-row");
  if (!targets.length) return [];
  const typeLabel = { dev: "开发", docs: "文档", plan: "Plan", review: "文档" }[workType] || "开发";
  const kind = area && area.kind === "docs" ? "文档区" : "代码区";
  const path = String((area && area.path) || "").trim();
  const payload = payloadOf({
    subject,
    priority: "",
    status: "已完成",
    note: `类型：${typeLabel}；区域：${kind}${path ? " " + path : ""}`,
    project,
  });
  const jobs = await updateQueue((list) => {
    const made = [];
    for (const c of targets) {
      const exist = list.find(
        (x) => x.connector === c.id && x.action === "update-row" && String(x.taskId) === String(taskId) && ["pending", "running"].includes(x.status)
      );
      if (exist) {
        exist.payload = payload;
        exist.updatedAt = Date.now();
        made.push(exist);
        continue;
      }
      const it = newJob(c, "update-row", payload, { id: nextId(list), taskId });
      list.push(it);
      made.push(it);
    }
    return made;
  });
  for (const job of jobs) if (job.connectorKind === "direct" && job.status === "pending") scheduleDirect(job.id);
  return jobs;
}

// 整理：每个启用且支持 cleanup 的连接器各一条；同一连接器只保留一条排队
export async function enqueueMaintenance({ note = "", docUrl, connector = "" } = {}) {
  const targets = connectors.enqueueTargets("cleanup").filter((c) => !connector || c.id === connector);
  if (!targets.length) return [];
  const payload = payloadOf({ subject: "整理文档主表", priority: "", status: "", note });
  const jobs = await updateQueue((list) => {
    const made = [];
    for (const c of targets) {
      const exist = list.find((x) => x.connector === c.id && x.action === "cleanup" && ["pending", "running"].includes(x.status));
      if (exist) {
        if (note) exist.payload.note = String(note);
        exist.updatedAt = Date.now();
        made.push(exist);
        continue;
      }
      const it = newJob(c, "cleanup", payload, { id: nextId(list), target: docUrl ? { url: docUrl } : {} });
      list.push(it);
      made.push(it);
    }
    return made;
  });
  for (const job of jobs) if (job.connectorKind === "direct" && job.status === "pending") scheduleDirect(job.id);
  return jobs;
}

export async function probe(connectorId) {
  const c = connectors.enabledConnectors().find((x) => x.id === String(connectorId));
  if (!c) throw new Error("连接器未启用或不存在: " + connectorId);
  if (!(c.config.actions || c.manifest.capabilities || []).includes("probe")) throw new Error("这个连接器不支持 probe");
  const payload = payloadOf({ subject: "LosFlow 连接器测试", priority: "", status: "测试", note: "设置页「测试行」", project: "probe" });
  const jobs = await updateQueue((list) => {
    const it = newJob(c, "probe", payload, { id: nextId(list) });
    list.push(it);
    return [it];
  });
  for (const job of jobs) if (job.connectorKind === "direct") scheduleDirect(job.id);
  return jobs[0];
}

// ---- 取活 / 回执 ----

// WorkBuddy 取活：只取 executor 连接器的 pending；传 connector 可限定
export function nextJob(connector = "") {
  const executorIds = new Set(connectors.executors().map((x) => x.id));
  return updateQueue((list) => {
    if (!executorIds.size) return null;
    const it = list.find((x) => {
      if (x.status !== "pending") return false;
      if (!executorIds.has(x.connector)) return false;
      return !connector || x.connector === String(connector);
    });
    if (!it) return null;
    it.status = "running";
    it.attempts = (Number(it.attempts) || 0) + 1;
    it.startedAt = Date.now();
    it.updatedAt = Date.now();
    return it;
  });
}

// 回调：done / failed（失败且还有额度就退回 pending，等下一轮 / 直连 worker）
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
      it.status = (Number(it.attempts) || 0) >= jobMaxAttempts(it) ? "failed" : "pending";
    }
    return it;
  }).then(async (it) => {
    connectors.noteHealth(it.connector, {
      ok: status === "done",
      error: status === "done" ? "" : it.lastError,
      action: it.action,
      jobId: it.id,
    });
    if (status === "done") await markTaskSynced(it.taskId);
    return it;
  });
}

// 回执成功就顺手把任务表里的这一条标成「台账已同步」，面板进度条靠它推进
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

// ---- 重放 ----

export async function replay(id) {
  const job = await updateQueue((list) => {
    const it = list.find((x) => String(x.id) === String(id));
    if (!it) throw new Error("没有这条文档同步: " + id);
    if (it.status !== "failed") throw new Error("只有 failed 的同步可以重放");
    it.status = "pending";
    it.attempts = 0;
    it.lastError = "";
    it.updatedAt = Date.now();
    return it;
  });
  if (job && job.connectorKind === "direct") scheduleDirect(job.id);
  return job;
}

export async function replayFailed(connector = "") {
  const jobs = await updateQueue((list) => {
    const out = [];
    for (const it of list) {
      if (it.status !== "failed") continue;
      if (connector && it.connector !== connector) continue;
      it.status = "pending";
      it.attempts = 0;
      it.lastError = "";
      it.updatedAt = Date.now();
      out.push(it);
    }
    return out;
  });
  for (const job of jobs) if (job.connectorKind === "direct") scheduleDirect(job.id);
  return { replayed: jobs.length, jobs };
}

// ---- 描述 / 摘要 ----

export function describeJob(job) {
  if (!job) return "暂无文档同步任务。";
  const head = [`connector: ${job.connector}`, `文档同步 #${job.id}（${job.action} · 第 ${job.attempts} 次尝试）`];
  if (job.taskId) head.push(`对应任务 #${job.taskId}`);
  const body = connectors.describe(job.connector, job.action, job.payload);
  return [...head, body, "写完用 report_docsync 回执：{id, status: \"done\", evidence: 行号/读回校验}；做不到就回填 failed，写清卡在哪一步 + 报错原文。"]
    .filter(Boolean)
    .join("\n");
}

export function cleanupNote({ connector = "", docUrl = "", note = "" } = {}) {
  const id = connector || connectors.executors()[0]?.id || "";
  let text = id ? connectors.describe(id, "cleanup", { note }) : "";
  if (!text) {
    text = [
      `文档 ${docUrl || "（未配置）"} 的主表。`,
      "任务：整理主表 —— 把【任务状态】为「已完成」或「已搁置」的数据行，从主表移除，按完成日期追加到「归档」tab。",
      "硬约束：",
      "1) 只动数据行，不动表头、序号公式、格式、筛选、隐藏列；",
      "2) 目标 tab 是「归档」（没有就先建，并把表头复制过去）；",
      "3) 逐行移动，移完读回核对：主表剩余行数、归档新增行数；",
      "4) 用 report_task 回填：移了几行、主表剩几行、归档现有几行、读回校验结果。",
      note ? `补充：${note}` : "",
      "做不到就回填 blocked，写清卡在哪一步 + 报错原文。",
    ].filter(Boolean).join("\n");
  }
  return text;
}

export function hasExecutors() {
  return connectors.executors().length > 0;
}

function count(list, status, connector = "") {
  return list.filter((x) => x.status === status && (!connector || x.connector === connector)).length;
}

export function summary() {
  const list = loadQueue();
  const byTask = {};
  for (const it of list) {
    const k = String(it.taskId || "");
    if (!k) continue;
    const prev = byTask[k];
    // 同一任务多个连接器：展示最近更新的那条（通常是 executor）
    if (!prev || Number(it.updatedAt || 0) >= Number(prev.updatedAt || 0)) {
      byTask[k] = {
        id: it.id,
        connector: it.connector,
        status: it.status,
        attempts: it.attempts || 0,
        error: it.lastError || "",
        updatedAt: it.updatedAt || null,
        doneAt: it.doneAt || null,
      };
    }
  }
  const byConnector = {};
  for (const it of list) {
    const k = String(it.connector || "unknown");
    const b = (byConnector[k] = byConnector[k] || { pending: 0, running: 0, done: 0, failed: 0, lastAt: 0 });
    if (b[it.status] !== undefined) b[it.status] += 1;
    b.lastAt = Math.max(b.lastAt, Number(it.updatedAt || 0));
  }
  return {
    pending: count(list, "pending"),
    running: count(list, "running"),
    done: count(list, "done"),
    failed: count(list, "failed"),
    byConnector,
    byTask,
    recent: list.slice(-20).reverse(),
  };
}

export function queueStats(connector = "") {
  const list = loadQueue();
  return {
    pending: count(list, "pending", connector),
    running: count(list, "running", connector),
    done: count(list, "done", connector),
    failed: count(list, "failed", connector),
    lastAt: list
      .filter((x) => !connector || x.connector === connector)
      .reduce((m, x) => Math.max(m, Number(x.updatedAt || 0)), 0),
  };
}

export function connectorsView() {
  return connectors.listConnectors().map((c) => ({ ...c, queueStats: queueStats(c.id) }));
}

// ---- 迁移 ----

function writeQueueSync(list) {
  const f = file();
  const tmp = `${f}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(list, null, 2), "utf8");
  try {
    renameSync(tmp, f);
  } catch {
    writeFileSync(f, JSON.stringify(list, null, 2), "utf8");
  }
}

function migrate() {
  const f = file();
  if (!existsSync(f)) return;
  const list = loadQueue();
  if (!list.length) return;
  let changed = false;
  const exec = connectors.executors();
  const fallback = exec[0]?.id || connectors.listConnectors().find((c) => c.kind === "executor")?.id || "tencent-wb";
  for (const it of list) {
    if (!it.connector) {
      it.connector = fallback;
      const ins = connectors.getConnector(fallback);
      it.connectorKind = ins ? ins.manifest.kind : "executor";
      changed = true;
    }
    if (!it.connectorKind) {
      const ins = connectors.getConnector(it.connector);
      it.connectorKind = ins ? ins.manifest.kind : "executor";
      changed = true;
    }
    if (!it.targetSnapshot || typeof it.targetSnapshot !== "object") {
      const cfg = connectors.getConfig(it.connector);
      it.targetSnapshot = { ...((cfg && cfg.target) || {}) };
      if (it.docUrl) it.targetSnapshot.url = it.docUrl;
      changed = true;
    }
    if (!it.mappingSnapshot) {
      const cfg = connectors.getConfig(it.connector);
      it.mappingSnapshot = { ...((cfg && cfg.mapping) || {}) };
      changed = true;
    }
    if (!it.queue) {
      const cfg = connectors.getConfig(it.connector);
      it.queue = { ...((cfg && cfg.queue) || {}) };
      changed = true;
    }
    if (!ACTIONS.includes(it.action)) {
      it.status = "failed";
      it.lastError = "未知动作，迁移后需人工处理";
      changed = true;
    }
  }
  if (changed) {
    try { copyFileSync(f, `${f}.bak`); } catch { /* ignore */ }
    writeQueueSync(list);
  }
}
