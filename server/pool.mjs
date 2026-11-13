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

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as docsync from "./docsync.mjs";
import { mutate } from "./store.mjs";

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

export function loadPool() {
  const list = readJson(poolFile(), []);
  return Array.isArray(list) ? list : [];
}

function nextPoolId(list) {
  const max = list.reduce((m, x) => Math.max(m, Number(String(x.id).replace(/\D/g, "")) || 0), 0);
  return "p" + (max + 1);
}

// 读-改-写全在 mutate 回调里：并发的加池/改确认/删除不会互相覆盖。
async function updatePool(fn) {
  let out = null;
  await mutate(poolFile(), (cur) => {
    const list = Array.isArray(cur) ? cur : [];
    out = fn(list);
    return list;
  });
  return out;
}

export function addPool({ title, note, kind, project, type }) {
  if (!title || !title.trim()) throw new Error("title required");
  return updatePool((list) => {
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
    return item;
  });
}

export function toggleConfirm({ id, field }) {
  if (!["detail", "flow", "auth"].includes(field)) throw new Error("bad field");
  return updatePool((list) => {
    const it = list.find((x) => x.id === id);
    if (!it) throw new Error("no such task: " + id);
    it.confirm = it.confirm || { detail: false, flow: false, auth: false };
    it.confirm[field] = !it.confirm[field];
    it.updatedAt = Date.now();
    return it;
  });
}

export function removePool(id) {
  return updatePool((list) => {
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) throw new Error("no such task: " + id);
    list.splice(idx, 1);
    return { removed: id };
  });
}

async function appendTasks(subs, kind) {
  let created = [];
  await mutate(tasksFile(), (cur) => {
    const tasks = Array.isArray(cur) ? cur : [];
    let maxId = tasks.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
    created = [];
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
    return tasks;
  });
  return created;
}

// 把选中的子任务作为「新的池子条目」加进来；本体留在池子里，地位一致
export function applySplit({ id, subs }) {
  if (!Array.isArray(subs) || !subs.length) throw new Error("subs required");
  return updatePool((list) => {
    const it = list.find((x) => x.id === id);
    if (!it) throw new Error("no such task: " + id);

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
    return { parent: it, created };
  });
}

// 推入：工作 Agent 立刻可开工，腾讯文档那一行走异步队列（docsync）。
//
// 派给谁：条目上显式写了 owner=workbuddy 才给 WorkBuddy；其余一律给工作 Agent
// （claude-code）。文档同步是 WorkBuddy 的活，但它是异步的，不挡开工。
export async function pushPool({ id, priority }) {
  const list = loadPool();
  const it = list.find((x) => x.id === id);
  if (!it) throw new Error("no such task: " + id);
  if (it.pushTaskId) throw new Error("已经推入过了");

  const pri = priority || "中";
  const worker = it.owner === "workbuddy" ? "workbuddy" : "claude-code";
  const childIds = it.children.map((cid) => String(cid));

  let created;
  if (childIds.length) {
    // 已拆过的条目：按 id 在 mutate 里就地更新，不拿快照覆盖别人刚写的字段
    const rows = [];
    await mutate(tasksFile(), (cur) => {
      const list = Array.isArray(cur) ? cur : [];
      for (const cid of childIds) {
        const t = list.find((x) => String(x.id) === cid);
        if (!t) continue;
        t.priority = pri;
        if (!t.owner) t.owner = worker;
        t.note = [(t.note || "").trim(), `优先级：${pri}`, "腾讯文档那一行由同步队列异步写入，不用手动补。"]
          .filter(Boolean)
          .join("\n");
        t.updatedAt = Date.now();
        rows.push(t);
      }
      return list;
    });
    created = rows;
  } else {
    created = await appendTasks([{
      title: it.title,
      owner: worker,
      note: [`优先级：${pri}`, it.note ? `说明：${it.note}` : "", "腾讯文档那一行由同步队列异步写入，不用手动补。"].filter(Boolean).join("\n"),
    }], it.kind);
  }
  if (!created.length) throw new Error("这条池条目没有可推入的任务");

  // 文档同步：一条任务一条，进异步队列等 WorkBuddy 来取
  const docJobs = await Promise.all(
    created.map((t) =>
      docsync.enqueue({ taskId: t.id, subject: t.subject, priority: pri, status: "开发中", note: it.note })
    )
  );

  const patch = {
    children: created.map((t) => t.id),
    stage: "pushed",
    pushTaskId: created.map((t) => t.id).join(","),
    docSyncId: docJobs.map((j) => j.id).join(","),
    priority: pri,
    pushedAt: Date.now(),
    updatedAt: Date.now(),
  };
  // 只改这一条：期间别人改的其他池条目（比如勾了三项确认）不会被这份快照盖掉
  await mutate(poolFile(), (cur) => {
    const curList = Array.isArray(cur) ? cur : [];
    const target = curList.find((x) => x.id === id);
    if (target) Object.assign(target, patch);
    return curList;
  });
  Object.assign(it, patch);
  return { item: it, created, docsync: docJobs };
}