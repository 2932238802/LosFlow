// pool.mjs -- 总任务池的读写与动作。
//
// 池子文件：<progressDir>\pool.json
// 任务表文件：<progressDir>\Vesta.tasks.json（与 taskboard.ps1 / wb-bridge 同一份）
//
// 三个确认位（对应杰哥要的三件事）：
//   detail  确认任务细则（需求写清楚了吗）
//   flow    确认任务流程（走不走标准流程）
//   auth    授权执行（允许动手）
//
// 三个动作：
//   split   把一条池任务拆成子任务，落到任务表，按 owner 派给 claude-code / workbuddy
//   push    推入：任务本体立刻可开工（默认派给工作 Agent），腾讯文档那一行异步入队
//   remove  从池子里删掉

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import * as docsync from "./docsync.mjs";

let PATHS = null;
export function initPool(paths) {
  PATHS = paths;
}

const poolFile = () => join(PATHS.dataDir, "pool.json");
const tasksFile = () => join(PATHS.dataDir, "Vesta.tasks.json");

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

export function loadPool() {
  const list = readJson(poolFile(), []);
  return Array.isArray(list) ? list : [];
}
function savePool(list) {
  writeJson(poolFile(), list);
}

export function loadTasks() {
  const list = readJson(tasksFile(), []);
  return Array.isArray(list) ? list : [];
}
function saveTasks(list) {
  try {
    // TEMP-DEBUG: 抓谁在写任务表
    appendFileSync("D:\\Temp\\tasks-writes.log", new Date().toISOString() + " pool.write\n" + new Error().stack + "\n");
  } catch {}
  writeJson(tasksFile(), list);
}

function nextPoolId(list) {
  const max = list.reduce((m, x) => Math.max(m, Number(String(x.id).replace(/\D/g, "")) || 0), 0);
  return "p" + (max + 1);
}

export function addPool({ title, note, kind, project, type }) {
  if (!title || !title.trim()) throw new Error("title required");
  const list = loadPool();
  const item = {
    id: nextPoolId(list),
    title: title.trim(),
    kind: kind === "company" ? "company" : "personal",
    project: project || "",
    type: type === "explore" ? "explore" : "task",
    note: (note || "").trim(),
    confirm: { detail: false, flow: false, auth: false },
    stage: "pool",            // pool | split | pushed
    children: [],             // 子任务 id
    pushTaskId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  list.push(item);
  savePool(list);
  return item;
}

export function toggleConfirm({ id, field }) {
  if (!["detail", "flow", "auth"].includes(field)) throw new Error("bad field");
  const list = loadPool();
  const it = list.find((x) => x.id === id);
  if (!it) throw new Error("no such task: " + id);
  it.confirm[field] = !it.confirm[field];
  it.updatedAt = Date.now();
  savePool(list);
  return it;
}

export function removePool(id) {
  const list = loadPool();
  const next = list.filter((x) => x.id !== id);
  if (next.length === list.length) throw new Error("no such task: " + id);
  savePool(next);
  return { removed: id };
}

function appendTasks(subs, kind) {
  const tasks = loadTasks();
  let maxId = tasks.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
  const created = [];
  for (const s of subs) {
    maxId += 1;
    const t = {
      id: String(maxId),
      subject: s.title,
      owner: s.owner || "claude-code",
      note: s.note || "",
      kind: kind || "personal",
      repo: s.repo || "",
      status: "todo",
      evidence: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    tasks.push(t);
    created.push(t);
  }
  saveTasks(tasks);
  return created;
}

// 把选中的子任务作为「新的池子条目」加进来；本体留在池子里，地位一致
export function applySplit({ id, subs }) {
  const list = loadPool();
  const it = list.find((x) => x.id === id);
  if (!it) throw new Error("no such task: " + id);
  if (!Array.isArray(subs) || !subs.length) throw new Error("subs required");

  const created = [];
  for (const s of subs) {
    const title = String(s.title || "").trim();
    if (!title) continue;
    const item = {
      id: nextPoolId(list.concat(created)),
      title,
      note: s.note || "",
      kind: it.kind || "personal",
      project: it.project || "",
      type: s.owner === "workbuddy" ? "task" : it.type || "task",
      confirm: { detail: false, flow: false, auth: false },
      stage: "pool",
      children: [],
      pushTaskId: null,
      parent: id,
      owner: s.owner || "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    created.push(item);
  }
  if (!created.length) throw new Error("没有可加入的子任务");
  list.push(...created);
  it.splitAt = Date.now();
  it.splitCount = (it.splitCount || 0) + created.length;
  it.updatedAt = Date.now();
  savePool(list);
  return { parent: it, created };
}

// 直接建一条任务（给维护类动作复用）
export function createTask({ title, owner, note, kind, repo, priority }) {
  const [t] = appendTasks([{ title, owner: owner || "workbuddy", note: note || "", repo: repo || "" }], kind || "personal");
  if (priority) {
    const tasks = loadTasks();
    const row = tasks.find((x) => String(x.id) === String(t.id));
    if (row) { row.priority = priority; saveTasks(tasks); }
  }
  return t;
}

// 推入：工作 Agent 立刻可开工，腾讯文档那一行走异步队列（docsync）。
//
// 派给谁：条目上显式写了 owner=workbuddy 才给 WorkBuddy；其余一律给工作 Agent
// （claude-code）。文档同步是 WorkBuddy 的活，但它是异步的，不挡开工。
export function pushPool({ id, priority }) {
  const list = loadPool();
  const it = list.find((x) => x.id === id);
  if (!it) throw new Error("no such task: " + id);
  if (it.pushTaskId) throw new Error("已经推入过了");

  const pri = priority || "中";
  const worker = it.owner === "workbuddy" ? "workbuddy" : "claude-code";
  const tasks = loadTasks();
  const rows = it.children.map((cid) => tasks.find((t) => String(t.id) === String(cid))).filter(Boolean);

  let created;
  if (rows.length) {
    for (const r of rows) {
      r.priority = pri;
      if (!r.owner) r.owner = worker;
      r.note = [(r.note || "").trim(), `优先级：${pri}`, "腾讯文档那一行由同步队列异步写入，不用手动补。"].filter(Boolean).join("\n");
      r.updatedAt = Date.now();
    }
    saveTasks(tasks);
    created = rows;
  } else {
    created = appendTasks([{
      title: it.title,
      owner: worker,
      note: [`优先级：${pri}`, it.note ? `说明：${it.note}` : "", "腾讯文档那一行由同步队列异步写入，不用手动补。"].filter(Boolean).join("\n"),
    }], it.kind);
  }

  // 文档同步：一条任务一条，进异步队列等 WorkBuddy 来取
  const docJobs = created.map((t) =>
    docsync.enqueue({ taskId: t.id, subject: t.subject, priority: pri, status: "开发中", note: it.note })
  );

  it.children = created.map((t) => t.id);
  it.stage = "pushed";
  it.pushTaskId = created.map((t) => t.id).join(",");
  it.docSyncId = docJobs.map((j) => j.id).join(",");
  it.priority = pri;
  it.pushedAt = Date.now();
  it.updatedAt = Date.now();
  savePool(list);
  return { item: it, created, docsync: docJobs };
}