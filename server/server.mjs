#!/usr/bin/env node
// 本地仪表盘 + 任务池工作台。
//
//   启动：node server/server.mjs [port]
//   默认 127.0.0.1:8899
//
// 读：_progress/Vesta.tasks.json、_progress/Vesta.json、_progress/pool.json、
//     tools/wb-bridge/calls.jsonl、tools/claude-ledger.jsonl
// 写：只写 pool.json 和 tasks.json（就是 taskboard.ps1 那份），别的都不碰。
//
// POST 一律要求头 `x-dash: 1`：浏览器跨站请求带不上自定义头，等于一个便宜的 CSRF 挡板。

import { createServer } from "node:http";
import { appendFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPaths } from "./paths.mjs";
import * as pool from "./pool.mjs";
import * as approvals from "./approvals.mjs";
import * as events from "./events.mjs";
import * as dispatch from "./dispatch.mjs";
import * as docsync from "./docsync.mjs";
import { renderMarkdown, wikiPage } from "./wiki.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PATHS = loadPaths();
const PORT = Number(process.argv[2] || process.env.DASH_PORT || PATHS.dashboardPort || 8899);
pool.initPool(PATHS);
approvals.initApprovals(PATHS);
events.initEvents(PATHS);
dispatch.initDispatch(PATHS);
docsync.initDocsync(PATHS);

const FILES = {
  tasks: join(PATHS.dataDir, "Vesta.tasks.json"),
  progress: join(PATHS.dataDir, "Vesta.json"),
  calls: join(PATHS.dataDir, "calls.jsonl"),
  ledger: join(PATHS.dataDir, "claude-ledger.jsonl"),
};

function readJson(p, fallback) {
  try {
    if (!existsSync(p)) return fallback;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonl(p, limit) {
  try {
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    const out = [];
    for (const l of lines) {
      try {
        out.push(JSON.parse(l));
      } catch {
        /* skip */
      }
    }
    return out.slice(-limit);
  } catch {
    return [];
  }
}

function todaySpend(ledger) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  let sum = 0;
  for (const r of ledger) if (r.at && r.at.startsWith(key) && r.cost_usd) sum += Number(r.cost_usd);
  return Math.round(sum * 1000) / 1000;
}

function syncBrain(taskId, subject, r) {
  try {
    if (!r || r.status !== "ok") return;
    const dir = PATHS.dataDir;
    const file = join(dir, "task-journal.md");
    const now = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
    const line = `- ${stamp} · #${taskId} ${subject} · ${r.status} · ${r.turns ?? "?"}轮 · ${Number(r.cost_usd || 0).toFixed(3)} · ${String(r.result || "").replace(/\n/g, " ").slice(0, 120)}\n`;
    appendFileSync(file, line, "utf8");
  } catch {
    /* 大脑写不进去不影响主流程 */
  }
}

const DEFAULT_TEMPLATES = {
  splitSystem: "你是任务拆分助手：把一条任务拆成 3-6 条可独立执行、可独立验收的子任务，粒度适中，不要互相依赖。",
  optimizeSystem: "你是提示词优化助手：把用户的草稿改写成一条能直接交给 Claude Code 执行的派单指令，说清做什么 / 照哪做 / 怎么验 / 要回执，只输出改写后的指令。",
};
function optimizeViaGateway(prompt, systemText) {
  return new Promise((resolve) => {
    const tmp = PATHS.tempDir || "D:\\Temp";
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const reqFile = join(tmp, "opt-" + id + ".json");
    const body = {
      model: "__MODEL__",
      max_tokens: 1200,
      system: systemText || "",
      messages: [{ role: "user", content: prompt }],
    };
    writeFileSync(reqFile, JSON.stringify(body), "utf8");
    const script = [
      "set -e",
      'eval "$(grep -E \'^export ANTHROPIC_\' /usr/bin/start_claude_code_jz)"',
      'body=$(cat ' + reqFile + ' | sed "s/__MODEL__/$ANTHROPIC_MODEL/")',
      'curl -s --max-time 90 -X POST "$ANTHROPIC_BASE_URL/v1/messages" ' +
        '-H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" ' +
        '-H "content-type: application/json" -d "$body"',
    ].join("\n");
    runWsl(script).then((r) => {
      try { unlinkSync(reqFile); } catch {}
      resolve({ ok: r.code === 0, raw: r.out, err: r.err });
    });
  });
}

function runWsl(cmd) {
  return new Promise((resolve) => {
    const tmp = PATHS.tempDir || "D:\\Temp";
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const outFile = join(tmp, "wsl-" + id + ".out");
    const errFile = join(tmp, "wsl-" + id + ".err");
    let fdOut, fdErr;
    try {
      fdOut = openSync(outFile, "w");
      fdErr = openSync(errFile, "w");
    } catch (e) {
      return resolve({ code: -1, out: "", err: "temp open failed: " + e.message });
    }
    const child = spawn("wsl.exe", ["-d", PATHS.wslDistro, "--", "bash", "-lc", cmd], {
      windowsHide: true,
      stdio: ["ignore", fdOut, fdErr],
    });
    closeSync(fdOut);
    closeSync(fdErr);
    child.on("error", (e) => resolve({ code: -1, out: "", err: e.message }));
    child.on("close", (code) => {
      let out = "", err = "";
      try { out = readFileSync(outFile, "utf8"); } catch {}
      try { err = readFileSync(errFile, "utf8"); } catch {}
      for (const f of [outFile, errFile]) { try { unlinkSync(f); } catch {} }
      resolve({ code, out, err });
    });
  });
}

const MAINT_FILE = () => join(PATHS.dataDir, "maintenance.json");
function loadMaint() {
  return readJson(MAINT_FILE(), { seenDone: [], count: 0, threshold: 5, lastAt: "" });
}
function saveMaint(v) {
  writeFileSync(MAINT_FILE(), JSON.stringify(v, null, 2), "utf8");
}

function cleanupNote() {
  const docUrl = "https://docs.qq.com/sheet/DZVFSeURwdmVJdVZL?tab=BB08J2";
  return [
    `文档 ${docUrl} 的主表（tab BB08J2）。`,
    "任务：整理主表 —— 把【任务状态】为「已完成」或「已搁置」的数据行，从主表移除，按完成日期追加到「归档」tab。",
    "硬约束：",
    "1) 只动数据行，不动表头、序号公式、格式、筛选、隐藏列；",
    "2) 目标 tab 是「归档」（没有就先建，并把表头复制过去）；",
    "3) 逐行移动，移完读回核对：主表剩余行数、归档新增行数；",
    "4) 用 report_task 回填：移了几行、主表剩几行、归档现有几行、读回校验结果。",
    "做不到就回填 blocked，写清卡在哪一步 + 报错原文。",
  ].join("\n");
}

function checkAutoCleanup() {
  try {
    const m = loadMaint();
    const tasks = readJson(FILES.tasks, []) || [];
    const doneIds = tasks.filter((t) => t.status === "done").map((t) => String(t.id));
    const fresh = doneIds.filter((id) => !(m.seenDone || []).includes(id));
    if (fresh.length) {
      m.count = (m.count || 0) + fresh.length;
      m.seenDone = doneIds;
    }
    const threshold = Number(m.threshold);
    if (threshold > 0 && m.count >= threshold) {
      pool.createTask({
        title: "整理腾讯文档主表：把已完成/已搁置的行移到归档",
        owner: "workbuddy",
        note: cleanupNote(),
        kind: "company",
      });
      m.count = 0;
      m.lastAt = new Date().toISOString();
    }
    saveMaint(m);
  } catch {
    /* 自动整理失败不影响主流程 */
  }
}

function loadTemplates() {
  const file = join(PATHS.dataDir, "prompt-templates.json");
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(DEFAULT_TEMPLATES, null, 2), "utf8");
    return { ...DEFAULT_TEMPLATES };
  }
  try {
    return { ...DEFAULT_TEMPLATES, ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return { ...DEFAULT_TEMPLATES };
  }
}
function saveTemplates(tpl) {
  writeFileSync(join(PATHS.dataDir, "prompt-templates.json"), JSON.stringify(tpl, null, 2), "utf8");
}

function loadProjects() {
  const file = join(PATHS.dataDir, "projects.json");
  if (!existsSync(file)) {
    const seed = [{ id: "vesta", name: "Vesta", path: "~/LosAngelous/Vesta" }];
    writeFileSync(file, JSON.stringify(seed, null, 2), "utf8");
    return seed;
  }
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}
function saveProjects(list) {
  writeFileSync(join(PATHS.dataDir, "projects.json"), JSON.stringify(list, null, 2), "utf8");
}

const STAGES = ["基线", "需求", "任务表", "文档", "确认", "开发", "Review", "验收", "收尾"];

function inferStage(tasks, progress, docByTask = {}) {
  if (!tasks.length) return 1;
  if (progress && (progress.blocked || progress.status === "waiting")) return null;
  const doing = tasks.filter((t) => t.status === "doing");
  if (doing.length) return doing.some((t) => (t.owner || "") === "claude-code") ? 5 : 6;
  const todo = tasks.filter((t) => t.status === "todo");
  if (todo.length) {
    // 异步文档同步回来了 → 台账就绪，阶段条推进到「任务表」；还没回来就停在「需求」
    const allSynced = todo.every((t) => {
      const d = docByTask[String(t.id)];
      return !d || d.status === "done"; // 没有文档同步要求（比如 WB 自己就是文档任务）不算卡点
    });
    return allSynced ? 3 : 2;
  }
  const open = tasks.filter((t) => t.status !== "done" && t.status !== "blocked");
  if (!open.length) return 8;
  return 7;
}

function wbActivityByTask() {
  const rows = readJsonl(join(PATHS.dataDir, "calls.jsonl"), 500);
  const map = {};
  for (const r of rows) {
    const id = String(r.taskId || "");
    if (!id) continue;
    const cur = map[id] || {};
    if (r.tool === "next_task") cur.takenAt = r.at;
    if (r.tool === "report_task") { cur.reportedAt = r.at; cur.reportStatus = r.args && r.args.status; }
    map[id] = cur;
  }
  return map;
}

// 正在跑的 Claude Code「终端」：WSL 里 /tmp/cc-<id>.pid 还活着的就算一个。
// running.json 只记最后一个，这里按 pid 文件如实数，能覆盖并发派单。
let terminalsCache = { at: 0, data: { count: 0, items: [] } };
// 历史派单产物：tools/runs/*.json 有多少、多大（终端回放和台账都靠它）
function historyStats() {
  let count = 0;
  let bytes = 0;
  try {
    const dir = join(PATHS.dataDir, "runs");
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        try {
          const st = statSync(join(dir, f));
          if (st.isFile()) { count += 1; bytes += st.size; }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return { runs: count, bytes };
}

function purgeHistory(hours) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  let runs = 0;
  try {
    const dir = join(PATHS.dataDir, "runs");
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        try {
          if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); runs += 1; }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return runs;
}

async function purgeWslTmp(hours) {
  // WSL /tmp 里的 cc-* 脚本、pid、stream：按修改时间删（同样走脚本文件）
  const r = await runWsl(`bash ${scanScript()} purge ${Math.round(hours * 60)}`);
  return Number(String(r.out || "0").trim()) || 0;
}


// Windows 路径 -> WSL 路径（D:\PROJECT\Ds -> /mnt/d/PROJECT/Ds）
function toWslPath(win) {
  return String(win)
    .replace(/^([A-Za-z]):[\\/]/, (_m, d) => `/mnt/${d.toLowerCase()}/`)
    .replace(/\\/g, "/");
}
const scanScript = () => toWslPath(join(PATHS.serverDir, "scan-terminals.sh"));

async function terminalRuns() {
  if (Date.now() - terminalsCache.at < 4000) return terminalsCache.data;
  // 走脚本文件，不要内联带引号的命令：wsl.exe 会吃掉内层引号
  let items = [];
  try {
    const r = await runWsl(`bash ${scanScript()}`);
    items = String(r.out || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
        const [rawId, pid] = line.split("|");
        const id = String(rawId || "").replace(/^cc-/, "");
        const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(id);
        const startedAt = m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : "";
        return { id, pid: Number(pid) || 0, startedAt };
      });
  } catch {
    items = [];
  }
  terminalsCache = { at: Date.now(), data: { count: items.length, items } };
  return terminalsCache.data;
}

async function buildState() {
  const tasks = readJson(FILES.tasks, []) || [];
  const progress = readJson(FILES.progress, {}) || {};
  const calls = readJsonl(FILES.calls, 40);
  const wbMap = wbActivityByTask();
  const ledger = readJsonl(FILES.ledger, 200);
  const runMap = {};
  for (const r of ledger) {
    const id = String(r.task_id || "");
    if (!id) continue;
    runMap[id] = { id: r.id || "", at: r.at || "", status: r.status || "", cost: Number(r.cost_usd || 0) };
  }
  const doc = docsync.summary();
  const terminals = await terminalRuns();
  const history = historyStats();
  return {
    now: new Date().toISOString(),
    stage: inferStage(tasks, progress, doc.byTask),
    stages: STAGES,
    progress: {
      status: progress.status || "",
      updated: progress.updated || "",
      blocked: progress.blocked || "",
      decision: progress.decision || "",
    },
    running: readJson(join(PATHS.dataDir, "running.json"), null),
    projects: loadProjects(),
    maintenance: loadMaint(),
    pool: pool.loadPool(),
    docsync: doc,
    terminals,
    history,
    approvals: approvals.loadApprovals().slice(-20).reverse(),
    allowlist: approvals.loadAllowlist(),
    tasks: tasks.map((t) => ({
      id: String(t.id),
      subject: t.subject || "",
      owner: t.owner || "",
      status: t.status || "",
      evidence: t.evidence || "",
      note: t.note || "",
      repo: t.repo || "",
      kind: t.kind || "personal",
      wb: wbMap[String(t.id)] || null,
      updatedAt: t.updatedAt || null,
      sessionId: t.sessionId || "",
      nudgedAt: t.nudgedAt || "",
      nudges: t.nudges || 0,
      docSync: doc.byTask[String(t.id)] || null,
      run: runMap[String(t.id)] || null,
    })),
    calls: calls
      .filter((c) => c.kind === "tool")
      .map((c) => ({ at: c.at, tool: c.tool, ok: c.ok, args: c.args }))
      .slice(-12)
      .reverse(),
    dispatches: ledger
      .slice(-10)
      .reverse()
      .map((r) => ({ at: r.at, status: r.status, cost: r.cost_usd, resumed: !!r.resumed_from, task: (r.task_preview || "").slice(0, 70) })),
    spendToday: todaySpend(ledger),
  };
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      chunks.push(c);
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      // 必须拼完 Buffer 再整体解码：逐块 toString 会把跨块的中文/emoji 拆成 U+FFFD
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

const ROUTES = {
  "/api/pool/add": (b) => pool.addPool({ title: b.title, note: b.note, kind: b.kind, project: b.project, type: b.type }),
  "/api/pool/toggle": (b) => pool.toggleConfirm({ id: b.id, field: b.field }),
  "/api/pool/apply": (b) => pool.applySplit({ id: b.id, subs: b.subs }),
  "/api/pool/suggest": async (b) => {
    const item = pool.loadPool().find((x) => x.id === b.id);
    if (!item) throw new Error("没有这条任务");
    const tpl = loadTemplates();
    const prompt = [
      tpl.splitSystem,
      "",
      `任务：${item.title}`,
      item.note ? `说明：${item.note}` : "",
      b.prompt ? `补充要求：${b.prompt}` : "",
      "",
      "只输出严格 JSON 数组，不要解释、不要代码块：",
      '[{"title":"子任务标题","owner":"claude-code 或 workbuddy","reason":"为什么单独拆"}]',
    ].filter(Boolean).join("\n");
    const r = await dispatch.runDispatch({ task: prompt, mode: "read", repo: item.project, taskId: b.id, budget: 0.35 });
    return { dispatch: r, raw: r.result || "" };
  },
  "/api/templates": (b) => {
    if (b && typeof b.splitSystem === "string") {
      const tpl = loadTemplates();
      tpl.splitSystem = b.splitSystem;
      tpl.optimizeSystem = typeof b.optimizeSystem === "string" ? b.optimizeSystem : tpl.optimizeSystem;
      saveTemplates(tpl);
      return { templates: tpl };
    }
    return { templates: loadTemplates() };
  },
  "/api/maintenance/config": (b) => {
    const m = loadMaint();
    if (b && typeof b.threshold !== "undefined") m.threshold = Math.max(0, Number(b.threshold) || 0);
    saveMaint(m);
    return { maintenance: m };
  },
  "/api/maintenance/cleanup": (b) => {
    const docUrl = b.docUrl || "https://docs.qq.com/sheet/DZVFSeURwdmVJdVZL?tab=BB08J2";
    const note = [
      `文档 ${docUrl} 的主表（tab BB08J2）。`,
      "任务：整理主表 —— 把【任务状态】为「已完成」或「已搁置」的数据行，从主表移除，按完成日期追加到「归档」tab。",
      "硬约束：",
      "1) 只动数据行，不动表头、序号公式、格式、筛选、隐藏列；",
      "2) 目标 tab 是「归档」（没有就先建，并把表头复制过去）；",
      "3) 逐行移动，移完读回核对：主表剩余行数、归档新增行数；",
      "4) 用 report_task 回填：移了几行、主表剩几行、归档现有几行、读回校验结果。",
      "做不到就回填 blocked，写清卡在哪一步 + 报错原文。",
    ].join("\n");
    const t = pool.createTask({ title: "整理腾讯文档主表：把已完成/已搁置的行移到归档", owner: "workbuddy", note, kind: "company" });
    return { task: t };
  },
  // 推入 = 两条线：任务本体立刻落库可开工；文档那一行进异步队列（docsync）。
  // 接口不等任何一边：三项确认里授权打勾 → 后台自动派给工作 Agent；否则只等你去点「执行」。
  "/api/pool/push": async (b) => {
    const out = pool.pushPool({ id: b.id, priority: b.priority });
    const auth = !!(out.item.confirm && out.item.confirm.auth);
    const autoStarted = [];
    for (const t of out.created) {
      if ((t.owner || "claude-code") !== "claude-code" || !auth) continue;
      autoStarted.push(String(t.id));
      setImmediate(() => {
        dispatch
          .runDispatch({ task: t.note || t.subject, mode: "read", repo: t.repo, taskId: t.id })
          .then((r) => {
            if (r && r.session_id) dispatch.setTaskTask(t.id, { sessionId: r.session_id });
            syncBrain(t.id, t.subject, r);
          })
          .catch((err) => syncBrain(t.id, t.subject, { status: "failed", error: err.message }));
      });
    }
    return { item: out.item, created: out.created, docsync: out.docsync, autoStarted };
  },
  "/api/docsync/report": (b) => docsync.report({ id: b.id, status: b.status, evidence: b.evidence }),
  // 清历史：删 N 小时前的 runs/*.json 与 WSL /tmp 里的 cc-*（台账和任务表不动）
  "/api/maintenance/purge": async (b) => {
    const hours = Math.max(1, Number(b.hours || 24));
    const runs = purgeHistory(hours);
    const wsl = await purgeWslTmp(hours);
    return { hours, runs, wsl, left: historyStats() };
  },
  "/api/pool/remove": (b) => pool.removePool(b.id),
  "/api/run/stop": () => dispatch.stopRun(),
  // 删掉单条历史会话：WSL /tmp 产物 + runs 归档 + 台账行 + 任务上的会话指针
  "/api/run/delete": async (b) => {
    const id = String(b.id || "").trim();
    if (!/^[0-9]{8}-[0-9]{6}-[0-9A-Za-z]{6}$/.test(id)) throw new Error("run id 不合法: " + id);
    const r = await runWsl(`bash ${scanScript()} delete ${id}`);
    const out = String(r.out || "").trim();
    if (out === "ALIVE") throw new Error("这条还在跑，先点「终止」再删");
    if (out.startsWith("BADID")) throw new Error("run id 不合法");
    const wslFiles = Number(out) || 0;

    // 台账：先取出这条的 session_id（用来清任务表），再把这一行删掉
    const ledgerFile = join(PATHS.dataDir, "claude-ledger.jsonl");
    let session = "";
    let ledgerRemoved = 0;
    const keepTasks = new Set();
    try {
      const lines = readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean);
      const keep = [];
      for (const l of lines) {
        let row;
        try { row = JSON.parse(l); } catch { keep.push(l); continue; }
        if (String(row.id) === id) { session = String(row.session_id || session); ledgerRemoved += 1; continue; }
        keep.push(l);
        const tid = String(row.task_id || "");
        if (tid) keepTasks.add(tid);
      }
      if (ledgerRemoved) writeFileSync(ledgerFile, keep.join("\n") + "\n", "utf8");
    } catch { /* skip */ }

    let removedRun = false;
    try {
      const rf = join(PATHS.dataDir, "runs", `${id}.json`);
      if (existsSync(rf)) { unlinkSync(rf); removedRun = true; }
    } catch { /* skip */ }

    let clearedTasks = 0;
    if (session || b.taskId) {
      try {
        const tasks = readJson(FILES.tasks, []) || [];
        let changed = false;
        for (const t of tasks) {
          const hitSession = session && String(t.sessionId || "") === session;
          // 这个任务已经没有别的派单记录了 → 指针一并不留（之后再跑就是新会话）
          const hitTask = b.taskId && String(t.id) === String(b.taskId) && !keepTasks.has(String(b.taskId));
          if (hitSession || hitTask) { t.sessionId = ""; t.updatedAt = Date.now(); changed = true; clearedTasks += 1; }
        }
        if (changed) writeFileSync(FILES.tasks, JSON.stringify(tasks, null, 2), "utf8");
      } catch { /* skip */ }
    }
    return { id, wslFiles, ledgerRemoved, removedRun, clearedTasks };
  },
  "/api/task/continue": async (b) => {
    const task = dispatch.getTask(b.id);
    if (!task) throw new Error("没有这条任务");
    if (!task.sessionId) throw new Error("这条任务还没有自己的会话，先点「执行」开一个");
    const r = await dispatch.runDispatch({
      task: b.task || task.note || task.subject,
      mode: "read",
      repo: task.repo,
      taskId: b.id,
      resume: task.sessionId,
    });
    if (r && r.session_id) dispatch.setTaskTask(b.id, { sessionId: r.session_id });
    syncBrain(b.id, task.subject, r);
    return { dispatch: r, session: r && r.session_id };
  },
  "/api/task/dispatch": async (b) => {
    const task = dispatch.getTask(b.id);
    if (!task) throw new Error("没有这条任务");
    // 每条任务一条独立会话：有就续接它自己的，没有就开新的
    const r = await dispatch.runDispatch({
      task: b.task || task.note || task.subject,
      mode: b.mode === "write" ? "write" : "read",
      allow: b.allow || "",
      repo: task.repo,
      taskId: b.id,
      resume: task.sessionId || "",
    });
    if (r && r.session_id) dispatch.setTaskTask(b.id, { sessionId: r.session_id });
    syncBrain(b.id, task.subject, r);
    return { dispatch: r, session: r && r.session_id };
  },
  "/api/projects/add": (b) => {
    const name = String(b.name || "").trim();
    const path = String(b.path || "").trim();
    if (!name || !path) throw new Error("名字和路径都要填");
    const list = loadProjects();
    if (list.some((x) => x.name === name)) throw new Error("同名项目已存在");
    list.push({ id: "p" + Date.now().toString(36), name, path });
    saveProjects(list);
    return { projects: list };
  },
  "/api/projects/remove": (b) => {
    const list = loadProjects().filter((x) => x.id !== b.id);
    saveProjects(list);
    return { projects: list };
  },
  "/api/task/explore": async (b) => {
    const task = dispatch.getTask(b.id);
    if (!task) throw new Error("没有这条任务");
    const prompt = [
      "这是一个探索任务：不要改任何代码。",
      `目标：${task.subject}`,
      task.note ? `补充：${task.note}` : "",
      "请先读相关代码与文档，找出可优化点（3-8 条），只输出严格 JSON：",
      '{"points":[{"title":"一句话结论","current":"现状","reason":"为什么是问题","gain":"预计提升（可量化就量化）","detail":"怎么做，2-3句","effort":"小/中/大"}]}',
      "不要解释、不要代码块，不要给与优化无关的建议。",
    ].filter(Boolean).join("\n");
    const r = await dispatch.runDispatch({
      task: prompt,
      mode: "read",
      repo: task.repo,
      taskId: b.id,
      budget: 0.4,
    });
    return { dispatch: r, raw: r.result || "" };
  },
  "/api/task/nudge": (b) => {
    const task = dispatch.getTask(b.id);
    if (!task) throw new Error("没有这条任务");
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
    dispatch.setTaskTask(b.id, {
      nudgedAt: stamp,
      nudges: (Number(task.nudges) || 0) + 1,
      status: task.status === "done" ? task.status : "todo",
    });
    const text = [
      "【取活提醒】有一条任务在等你，请立刻调用 next_task(owner=\"workbuddy\") 取走并执行：",
      `#${task.id} ${task.subject}`,
      task.priority ? `优先级：${task.priority}` : "",
      "做完用 report_task 回填结论 + 证据。",
      "如果这条不该你做，回填 blocked 并说明原因，不要放着不管。",
    ].filter(Boolean).join("\n");
    return { text, nudgedAt: stamp, nudges: (Number(task.nudges) || 0) + 1 };
  },
  "/api/task/note": (b) => dispatch.setTaskTask(b.id, { note: String(b.note || "") }),
  "/api/task/delete": (b) => dispatch.deleteTask(b.id),
  "/api/prompt/optimize": async (b) => {
    const text = (b.text || "").trim();
    if (!text) throw new Error("提示词为空");
    const prompt = [
      "把下面这段需求改写成一条能直接交给 Claude Code 执行的派单指令。",
      "要求：只用一段话；说清 做什么 / 照哪做（给路径或文档，不要贴全文）/ 怎么验（具体命令）/ 要回执。",
      "不要解释、不要客套、不要代码块，直接输出改写后的指令。",
      "",
      text,
    ].join("\n");
    const r = await dispatch.runDispatch({ task: prompt, mode: "read", taskId: b.taskId });
    return { prompt: (r.result || "").trim(), status: r.status, cost: r.cost_usd };
  },
  "/api/task/repo": (b) => dispatch.setTaskTask(b.id, { repo: b.repo }),
  "/api/task/docs": async (b) => {
    const prompt = [
      `任务：${b.title}`,
      b.note ? `补充：${b.note}` : "",
      "请输出严格 JSON（不要解释、不要代码块）：",
      '{"requirement":"需求描述（3-5句）","deliverables":["交付事项1","..."],"acceptance":["验收事项1","..."]}',
      "要求：验收事项必须是可逐条勾选验证的动作。",
    ].filter(Boolean).join("\\n");
    const task = dispatch.getTask(b.id);
    const r = await dispatch.runDispatch({ task: prompt, mode: "read", repo: task && task.repo, taskId: b.id });
    return { dispatch: r, raw: r.result || "" };
  },
  "/api/task/split": async (b) => {
    const prompt = [
      `把任务拆成 3-6 个子任务：${b.title}`,
      b.note ? `补充：${b.note}` : "",
      "输出严格 JSON 数组（不要解释）：",
      '[{"title":"子任务","owner":"claude-code 或 workbuddy"}]',
    ].filter(Boolean).join("\\n");
    const task = dispatch.getTask(b.id);
    const r = await dispatch.runDispatch({ task: prompt, mode: "read", repo: task && task.repo, taskId: b.id });
    return { dispatch: r, raw: r.result || "" };
  },
  "/api/task/optimize": async (b) => {
    const prompt = [
      "把下面这段任务说明改写成给 Claude Code 用的 SKILL.md（含 frontmatter name/description，正文写清四件套）。只输出 SKILL.md 全文。",
      `任务：${b.title}`,
      b.note ? `补充：${b.note}` : "",
    ].filter(Boolean).join("\\n");
    const task = dispatch.getTask(b.id);
    const r = await dispatch.runDispatch({ task: prompt, mode: "read", repo: task && task.repo, taskId: b.id });
    return { dispatch: r, skill: r.result || "" };
  },
  "/api/approve": (b) => approvals.approve({ id: b.id }),
  "/api/reject": (b) => approvals.reject({ id: b.id }),
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");

  if (req.method === "GET" && (url.pathname === "/wiki" || url.pathname === "/wiki/")) {
    try {
      const md = readFileSync(join(PATHS.webDir, "wiki.md"), "utf8");
      const html = wikiPage("LosFlow · 驾驶舱说明", renderMarkdown(md));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      return res.end("wiki.md 读不到: " + err.message);
    }
  }

  if (req.method === "GET" && url.pathname === "/api/wsl/ls") {
    const raw = String(url.searchParams.get("path") || "~");
    if (/["'\n\r;$]/.test(raw)) return sendJson(res, 400, { error: "路径里有非法字符" });
    // bash 里 cd "~" 不会展开，换成 $HOME
    let target = raw === "" || raw === "~" ? "$HOME" : raw;
    if (target.startsWith("~/")) target = "$HOME/" + target.slice(2);
    const cmd = `cd "${target}" 2>/dev/null && pwd && echo '---DIRS---' && ls -1d */ 2>/dev/null | head -300`;
    const r = await runWsl(cmd);
    const [pwdPart, dirsPart] = String(r.out || "").split("---DIRS---");
    const cwd = (pwdPart || "").trim();
    const dirs = (dirsPart || "").split("\n").map((x) => x.trim()).filter(Boolean).map((x) => x.replace(/\/$/, ""));
    const parent = cwd && cwd !== "/" ? cwd.split("/").slice(0, -1).join("/") || "/" : "";
    return sendJson(res, 200, { path: cwd || target, parent, dirs, error: r.code !== 0 ? (r.err || "打不开").slice(0, 200) : "" });
  }

  if (req.method === "GET" && url.pathname === "/api/templates") {
    return sendJson(res, 200, { templates: loadTemplates() });
  }

  if (req.method === "GET" && url.pathname === "/api/docsync") {
    return sendJson(res, 200, docsync.summary());
  }

  if (req.method === "GET" && url.pathname === "/api/task/raw") {
    const id = url.searchParams.get("id");
    const run = readJson(join(PATHS.dataDir, "running.json"), null);
    let dispatchId = run && String(run.taskId || "") === String(id) ? run.id : null;
    if (!dispatchId) {
      const row = dispatch.latestDispatchFor(id);
      dispatchId = row && row.id;
    }
    if (!dispatchId) return sendJson(res, 200, { dispatch: null, lines: [] });
    return sendJson(res, 200, { dispatch: dispatchId, running: !!(run && run.id === dispatchId), lines: events.readRunRaw(dispatchId) });
  }

  if (req.method === "GET" && url.pathname === "/api/task/log") {
    const id = url.searchParams.get("id");
    const run = readJson(join(PATHS.dataDir, "running.json"), null);
    if (run && run.id && String(run.taskId || "") === String(id)) {
      return sendJson(res, 200, {
        dispatch: { id: run.id, status: "running", at: run.startedAt, task: run.task },
        events: events.readRunEvents(run.id),
      });
    }
    const row = dispatch.latestDispatchFor(id);
    if (!row) return sendJson(res, 200, { dispatch: null, events: [] });
    return sendJson(res, 200, {
      dispatch: { id: row.id, status: row.status, at: row.at, cost: row.cost_usd, turns: row.turns, session: row.session_id },
      events: events.readRunEvents(row.id),
    });
  }
  if (req.method === "GET" && url.pathname === "/events/claude") return events.streamClaude(req, res);
  if (req.method === "GET" && url.pathname === "/events/workbuddy") return events.streamWorkbuddy(req, res);

  if (req.method === "GET" && url.pathname === "/api/state") {
    return sendJson(res, 200, await buildState());
  }

  if (req.method === "POST" && ROUTES[url.pathname]) {
    if (req.headers["x-dash"] !== "1") return sendJson(res, 403, { error: "missing x-dash header" });
    try {
      const body = await readBody(req);
      const out = await ROUTES[url.pathname](body);
      return sendJson(res, 200, { ok: true, result: out });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  // SPA（web 构建产物）：/app/* -> web/dist
  if (req.method === "GET" && url.pathname === "/app") {
    res.writeHead(302, { location: "/app/" });
    return res.end();
  }

  if (req.method === "GET" && url.pathname.startsWith("/app/")) {
    const dist = PATHS.webDist;
    const rel = url.pathname.replace(/^\/app\/?/, "") || "index.html";
    const file = join(dist, rel);
    try {
      const buf = readFileSync(file);
      const ext = rel.split(".").pop();
      const types = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", svg: "image/svg+xml", json: "application/json" };
      res.writeHead(200, { "content-type": types[ext] || "application/octet-stream", "cache-control": "no-store" });
      return res.end(buf);
    } catch {
      try {
        const idx = readFileSync(join(dist, "index.html"));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(idx);
      } catch {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        return res.end("web not built. run: npm run build");
      }
    }
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    try {
      const html = readFileSync(join(HERE, "index.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      return res.end("index.html missing: " + err.message);
    }
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

setInterval(checkAutoCleanup, 60000);
checkAutoCleanup();

server.listen(PORT, "127.0.0.1", () => {
  console.log(`dashboard: http://127.0.0.1:${PORT}`);
});
