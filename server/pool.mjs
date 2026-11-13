// pool.mjs -- 总任务池的读写与动作。
//
// 池子文件：<progressDir>\pool.json
// 任务表文件：<progressDir>\Vesta.tasks.json（与 taskboard.ps1 / wb-bridge 同一份）
//
// 工作类型（workType）：dev / docs / plan，加入池子时定下来；
// 优化提示词、拆分继承、推入建任务、标记完成、文档回填都沿用它。
//
// 三个动作：
//   split   把一条池任务拆成子任务，落到任务表，按 owner 派给 claude-code / workbuddy
//   push    推入：任务本体落库并自动派单（WorkBuddy 任务等 WB 取走），腾讯文档那一行异步入队
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

// 工作类型：加入池子时就定，优化提示词 / 推入 / 标记完成都沿用它。
// review 是旧数据（旧版「标记完成」的类型），读时按「文档」处理。
export function normWorkType(v) {
  const s = String(v || "");
  if (s === "review") return "docs";
  return s === "docs" || s === "plan" ? s : "dev";
}

export function loadPool() {
  const list = readJson(poolFile(), []);
  if (!Array.isArray(list)) return [];
  // 旧数据的 confirm 三项确认已废弃：读时剥掉，不再下发 / 展示。
  return list.map(({ confirm, ...rest }) => ({ ...rest, workType: normWorkType(rest.workType) }));
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

export function addPool({ title, note, kind, project, type, workType }) {
  if (!title || !title.trim()) throw new Error("title required");
  return updatePool((list) => {
    const item = {
      id: nextPoolId(list),
      title: title.trim(),
      kind: kind === "company" ? "company" : "personal",
      project: project || "",
      type: type === "explore" ? "explore" : "task",
      note: (note || "").trim(),
      workType: normWorkType(workType),
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

// 工作类型可在池子里改（包括拆出来的子条目）；推入后任务行也带上它。
export function setWorkType({ id, workType }) {
  return updatePool((list) => {
    const it = list.find((x) => x.id === id);
    if (!it) throw new Error("no such task: " + id);
    it.workType = normWorkType(workType);
    it.updatedAt = Date.now();
    return it;
  });
}

export function removePool(id) {
  return updatePool((list) => {
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) throw new Error("no such task: " + id);
    const it = list[idx];
    const childCount = (Array.isArray(it.children) ? it.children : []).filter((cid) =>
      list.some((x) => x.id === cid && x.parent === id)
    ).length;
    list.splice(idx, 1);
    // 不级联删子条目：只留 parent 标记，界面上显示「父条目已删除」
    return { removed: id, children: childCount };
  });
}

// 编辑「任务本身」（正文）。拆分/推入都要求非空，但编辑本身允许清空后重写。
export function setNote({ id, note }) {
  const text = String(note ?? "");
  return updatePool((list) => {
    const it = list.find((x) => x.id === id);
    if (!it) throw new Error("no such task: " + id);
    it.note = text.trim();
    it.updatedAt = Date.now();
    return { id: it.id, note: it.note, parent: it.parent || "" };
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
        priority: s.priority || "",
        // 一开始就定好的工作类型：优化提示词、标记完成、文档回填都沿用它
        workType: normWorkType(s.workType),
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

// 把选中的子任务作为「新的池子条目」加进来；本体留在池子里，地位一致。
// 「任务本身」（note）是必填产物：子条目没有正文就不允许入池（后端也校验，不靠前端自觉）。
export function applySplit({ id, subs }) {
  if (!Array.isArray(subs) || !subs.length) throw new Error("subs required");
  return updatePool((list) => {
    const it = list.find((x) => x.id === id);
    if (!it) throw new Error("no such task: " + id);
    const parentNote = String(it.note || "").trim();
    const parentWorkType = normWorkType(it.workType);

    const created = [];
    for (const s of subs) {
      const title = String(s.title || "").trim();
      if (!title) continue;
      // AI 没给 note 时可以沿用父任务正文（父亲写好的任务本身），但绝不能是空
      const note = String(s.note || "").trim() || parentNote;
      if (!note) throw new Error(`子任务缺少任务本身（note）：${title}`);
      const item = {
        id: nextPoolId(list.concat(created)),
        title,
        note,
        kind: it.kind || "personal",
        project: it.project || "",
        type: s.owner === "workbuddy" ? "task" : it.type || "task",
        // 工作类型默认继承父条目；拆分弹层里可以按条改
        workType: normWorkType(s.workType || parentWorkType),
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

    // 父记录自己的子条目（pool id），拆完不再显示「未拆」，也不能按父标题重复推一条
    it.children = (Array.isArray(it.children) ? it.children : []).filter((cid) =>
      list.some((x) => x.id === cid && x.parent === id)
    );
    it.children.push(...created.map((c) => c.id));
    it.stage = "split";
    it.splitAt = Date.now();
    it.splitCount = (it.splitCount || 0) + created.length;
    it.updatedAt = Date.now();
    return { parent: it, created };
  });
}

// 推入：工作 Agent 立刻可开工，腾讯文档那一行走异步队列（docsync）。
//
// 规则：
//   - note 只放「任务本身」：优先级是独立字段，不再拼「优先级：X / 腾讯文档…」进正文；
//   - 没有正文的条目不推入（在花钱之前失败）；
//   - 父条目拆过之后，推入的是**子条目**，不会按父标题再建一条；
//   - 已推入的子条目跳过，重复点不会重复建任务。
export async function pushPool({ id, priority }) {
  const list = loadPool();
  const it = list.find((x) => x.id === id);
  if (!it) throw new Error("no such task: " + id);
  if (it.pushTaskId) throw new Error("已经推入过了");

  const pri = priority || "中";
  const childIds = (Array.isArray(it.children) ? it.children : [])
    .map(String)
    .filter((cid) => list.some((x) => x.id === cid && x.parent === id));

  // 拆过但子条目全被删了：不能退化成「按父标题再建一条」
  if (!childIds.length && Array.isArray(it.children) && it.children.length) {
    throw new Error(`这条已拆成 ${it.children.length} 条子任务，但子条目都已不存在；请重新拆分或删除父条目`);
  }

  let targets;
  if (childIds.length) {
    const kids = childIds.map((cid) => list.find((x) => x.id === cid)).filter(Boolean);
    const pending = kids.filter((k) => !k.pushTaskId);
    if (!pending.length) throw new Error(`这条已拆成 ${kids.length} 条子任务，且都已推入过`);
    targets = pending;
  } else {
    targets = [it];
  }

  // fail fast：没有任务本身就不推入，避免 Claude Code 只收到空壳
  for (const t of targets) {
    if (!String(t.note || "").trim()) {
      throw new Error(`「${t.title}」没有任务本身，先补正文（池子卡片 → 编辑正文）`);
    }
  }

  const workerOf = (t) => (t.owner === "workbuddy" || (!t.owner && it.owner === "workbuddy") ? "workbuddy" : "claude-code");
  const created = await appendTasks(
    targets.map((t) => ({
      title: t.title,
      owner: workerOf(t),
      note: String(t.note || "").trim(),
      repo: t.project || it.project || "",
      priority: pri,
      workType: t.workType || it.workType || "dev",
    })),
    it.kind
  );
  if (!created.length) throw new Error("这条池条目没有可推入的任务");

  // 文档同步：一条任务一条，备注用**这条任务自己的正文**，不是父条目的
  const docJobs = await Promise.all(
    created.map((t) =>
      docsync.enqueue({ taskId: t.id, subject: t.subject, priority: pri, status: "开发中", note: t.note })
    )
  );

  const patches = new Map(targets.map((t, i) => [String(t.id), created[i]]));
  await mutate(poolFile(), (cur) => {
    const curList = Array.isArray(cur) ? cur : [];
    for (const [tid, task] of patches) {
      const target = curList.find((x) => String(x.id) === tid);
      if (!target) continue;
      target.pushTaskId = task.id;
      target.pushedTaskIds = Array.from(new Set([...(target.pushedTaskIds || []), task.id]));
      target.stage = "pushed";
      target.priority = pri;
      target.pushedAt = Date.now();
      target.updatedAt = Date.now();
    }
    const parent = curList.find((x) => String(x.id) === String(id));
    if (parent && childIds.length) {
      // 父条目本身不建任务，只记录「子任务推入了哪些任务行」
      parent.pushedTaskIds = Array.from(new Set([...(parent.pushedTaskIds || []), ...created.map((t) => t.id)]));
      parent.priority = pri;
      parent.pushedAt = Date.now();
      parent.updatedAt = Date.now();
    }
    return curList;
  });

  const fresh = loadPool().find((x) => String(x.id) === String(id)) || it;
  Object.assign(it, fresh);
  return { item: it, created, docsync: docJobs, pushedChildren: childIds.length ? created.length : 0 };
}