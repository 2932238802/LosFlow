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
import { appendFileSync, openSync, closeSync, unlinkSync, createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPaths } from "./paths.mjs";
import { resolveEnv } from "./env.mjs";
import * as pool from "./pool.mjs";
import * as approvals from "./approvals.mjs";
import * as events from "./events.mjs";
import * as dispatch from "./dispatch.mjs";
import * as docsync from "./docsync.mjs";
import * as jobs from "./jobs.mjs";
import * as skills from "./skills.mjs";
import * as notify from "./notify.mjs";
import { mutate } from "./store.mjs";
import { renderMarkdown, wikiPage } from "./wiki.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PATHS = loadPaths();
const PORT = Number(process.argv[2] || process.env.DASH_PORT || PATHS.dashboardPort || 8899);
pool.initPool(PATHS);
approvals.initApprovals(PATHS);
events.initEvents(PATHS);
dispatch.initDispatch(PATHS);
docsync.initDocsync(PATHS);
jobs.initJobs(PATHS);
skills.initSkills(PATHS);
notify.initNotify(PATHS, {
  isPending: (id) => approvals.loadApprovals().some((a) => String(a.id) === String(id) && a.status === "pending"),
});

// 实时审批：MCP 把请求写进 data/live，审批队列扫描后广播给右侧栏。
// 降级 C：live 没接住（关闭 / MCP 异常）时，流里一出现 reject 就立刻入队。
approvals.startLiveWatch((evt) => events.broadcast(evt), (id) => dispatch.getTask(id));
events.setDenialSink((d) => {
  try {
    const task = dispatch.getTask(d.taskId);
    approvals.recordMidRunDenial({
      ...d,
      task: task ? [task.subject, task.note].filter(Boolean).join("\n\n") : "",
      repo: (task && task.repo) || "",
      env: task ? envOfTask(task) : "",
      mode: "read",
    });
  } catch {
    /* 入队失败不影响终端流 */
  }
});

const FILES = {
  tasks: join(PATHS.dataDir, "Vesta.tasks.json"),
  calls: join(PATHS.dataDir, "calls.jsonl"),
  ledger: join(PATHS.dataDir, "claude-ledger.jsonl"),
};

// ---- 环境判定（唯一入口：server/env.mjs）----
// 任务上的 env 是「模式」：'' / 'auto' 按 repo 现算；'wsl' / 'windows' 是派单时固化的结果。
const defaultEnv = () => PATHS.defaultEnv || "wsl";
function envOfTask(t) {
  const mode = t && t.env ? String(t.env) : "";
  return resolveEnv(t && t.repo, mode === "auto" ? "" : mode, defaultEnv());
}
function publicProject(p) {
  const mode = p && p.env ? String(p.env) : "auto";
  return { ...p, env: mode, resolvedEnv: resolveEnv(p && p.path, mode === "auto" ? "" : mode, defaultEnv()) };
}

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

// ---- 网关配置（元调用直连，去 WSL 单点）----
// 优先级：losflow.config.json 的 windowsClaudeEnv → 本机环境变量 → WSL 启动器（旧兜底）。
// 以前 server.mjs 从 WSL 里 grep start_claude_code_jz 取 key：WSL 一停，优化/拆分/文档全跟着挂。
let gatewayCache = { at: 0, cfg: null };
function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function gatewayFromWsl() {
  const script = [
    'eval "$(grep -E \'^export ANTHROPIC_\' /usr/bin/start_claude_code_jz)" 2>/dev/null',
    'echo "$ANTHROPIC_BASE_URL"',
    'echo "$ANTHROPIC_API_KEY"',
    'echo "$ANTHROPIC_MODEL"',
  ].join("\n");
  const r = await runWsl(script);
  const [base = "", key = "", model = ""] = String(r.out || "").split("\n").map((x) => x.trim());
  return { base, key, model };
}

async function gatewayConfig() {
  if (gatewayCache.cfg && Date.now() - gatewayCache.at < 5 * 60 * 1000) return gatewayCache.cfg;
  const src = PATHS.windowsClaudeEnv || {};
  let base = src.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || "";
  let key = src.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || "";
  let model = src.ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL || "";
  if (!base || !key) {
    const w = await gatewayFromWsl();
    base = base || w.base;
    key = key || w.key;
    model = model || w.model;
  }
  const cfg = base && key ? { base, key, model } : null;
  gatewayCache = { at: Date.now(), cfg };
  return cfg;
}

// 元调用（提示词优化 / 拆分 / 文档）只需要一次纯文本补全：直连网关即可。
// 回执不带金额，记一行 cost_usd=null（billing=unknown）留痕，spendToday 会跳过它。
async function metaChat(prompt, systemText = "") {
  const g = await gatewayConfig();
  if (!g) return { ok: false, raw: "", err: "gateway not configured (windowsClaudeEnv / WSL launcher unavailable)", via: "" };
  try {
    const url = g.base.replace(/\/+$/, "") + "/v1/messages";
    const res = await fetch(url, {
      method: "POST",
      // 元调用不能无限挂着：网关不通 / WSL 没起来时 90 s 内明确失败，调用方（job）才有终态
      signal: AbortSignal.timeout(90 * 1000),
      headers: { "content-type": "application/json", "x-api-key": g.key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: g.model || "deepseek-v4-flash",
        max_tokens: 1600,
        system: systemText || "",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* keep raw */ }
    const raw = j && Array.isArray(j.content) ? j.content.filter((b) => b && b.type === "text").map((b) => b.text || "").join("") : "";
    const ok = res.ok && !!raw.trim();
    try {
      appendFileSync(FILES.ledger, JSON.stringify({
        id: "meta-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
        at: nowStamp(), task_id: "", env: "gateway", repo: "", mode: "meta",
        status: ok ? "ok" : "error", cost_usd: null, billing: "unknown",
        model: g.model || "", result_preview: String(raw || "").slice(0, 200), result_len: String(raw || "").length,
        error: ok ? "" : String(text || "").slice(0, 300),
        task_preview: "(meta call)",
      }) + "\n", "utf8");
    } catch { /* 记账失败不影响元调用 */ }
    return { ok, raw: ok ? raw : text.slice(0, 400), err: ok ? "" : text.slice(0, 300), via: "gateway" };
  } catch (e) {
    const timeout = e && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, raw: "", err: timeout ? "网关 90 秒无响应" : e.message, via: "gateway" };
  }
}

// 元调用优先直连网关；配置不可用 / 网关报错时退回旧派单链路（保持可用性）。
async function metaOrDispatch(prompt, fallbackOpts = {}) {
  const m = await metaChat(prompt, "");
  if (m.ok && String(m.raw || "").trim()) {
    return { dispatch: { status: "ok", cost: null, via: m.via || "gateway" }, raw: String(m.raw).trim() };
  }
  const r = await dispatch.runDispatch({ task: prompt, mode: "read", ...fallbackOpts });
  return { dispatch: r, raw: r.result || "" };
}

// 兼容旧调用点：名字保留，内部改成直连（失败时退回原来的 WSL curl）。
async function optimizeViaGateway(prompt, systemText) {
  const r = await metaChat(prompt, systemText);
  if (r.ok || r.raw) return r;
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
  const w = await runWsl(script);
  try { unlinkSync(reqFile); } catch { /* ignore */ }
  return { ok: w.code === 0, raw: w.out, err: w.err, via: "wsl" };
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
    // 文档同步类任务（docOnly）不算「完成了一条开发任务」，别让它们触发整理
    const doneIds = tasks.filter((t) => t.status === "done" && !t.docOnly).map((t) => String(t.id));
    const fresh = doneIds.filter((id) => !(m.seenDone || []).includes(id));
    if (fresh.length) {
      m.count = (m.count || 0) + fresh.length;
      m.seenDone = doneIds;
    }
    const threshold = Number(m.threshold);
    if (threshold > 0 && m.count >= threshold) {
      // 整理主表是纯文档活：只入 docsync 队列交给 WorkBuddy，不建任务、不进终端
      docsync.enqueueMaintenance({ note: cleanupNote() }).catch(() => undefined);
      m.count = 0;
      m.lastAt = new Date().toISOString();
    }
    saveMaint(m);
  } catch {
    /* 自动整理失败不影响主流程 */
  }
}

// 存量兜底：历史上「写腾讯文档」被建成普通任务（例如 #5）的，补上 docOnly。
// 任务页 / 终端页不再渲染它，证据仍留在任务表与 /api/state 里可查。
function markLegacyDocTasks() {
  try {
    const tasks = readJson(FILES.tasks, []) || [];
    let changed = false;
    for (const t of tasks) {
      if (t.docOnly) continue;
      // 只看 WorkBuddy 名下的文档活，避免误伤开发任务
      if ((t.owner || "") !== "workbuddy") continue;
      if (!docsync.isDocSyncInstruction([t.subject, t.note].filter(Boolean).join("\n"))) continue;
      t.docOnly = true;
      t.docOnlyAt = Date.now();
      t.updatedAt = Date.now();
      changed = true;
    }
    if (changed) writeFileSync(FILES.tasks, JSON.stringify(tasks, null, 2), "utf8");
  } catch {
    /* 回填失败不影响主流程 */
  }
}

function assertDispatchable(task) {
  if (task.docOnly) {
    throw new Error("这条是腾讯文档同步任务，不派给 Claude Code；写文档走文档同步队列，WorkBuddy 会取走");
  }
  if ((task.owner || "") === "workbuddy" && docsync.isDocSyncInstruction([task.subject, task.note].filter(Boolean).join("\n"))) {
    throw new Error("这条是腾讯文档操作指令，不派给 Claude Code；请走文档同步队列（WorkBuddy 的 next_docsync）");
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

// 拆分提示词：正文、字段契约与硬规则都在 docs/skills/split.md（可编辑、可 diff）。
// 路由只负责把 任务 / 说明 / 补充要求 填进占位符；缺文件时 skills.mjs 会写内置默认。
function buildSplitPrompt(item, extra = "") {
  const skill = skills.loadSkill("split");
  return skills.renderSplitPrompt(skill, { title: item.title, note: item.note || "", extra });
}

// 给前端的 SKILL 视图：不暴露解析内部结构，只给名字/路径/正文/字段/错误
function publicSkill(s) {
  return {
    name: s.name,
    path: s.path,
    content: s.content,
    output: s.meta ? s.meta.output : "text",
    fields: s.meta ? s.meta.fields : [],
    error: s.error || "",
  };
}

function skillsPreview() {
  const s = skills.loadSkill("split");
  return skills.renderSplitPrompt(s, {
    title: "示例任务标题",
    note: "示例任务本身（正文）",
    extra: "",
  });
}

function loadProjects() {
  const file = join(PATHS.dataDir, "projects.json");
  if (!existsSync(file)) {
    const seed = [{ id: "vesta", name: "Vesta", path: "~/LosAngelous/Vesta", env: "auto" }];
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

// ---- 机器相关配置（losflow.config.json）：只开放派单环境相关的非敏感字段 ----
// windowsClaudeEnv 里有网关 key：既不返回也不接收，只能手工写进 gitignored 的配置文件。
const configFile = () => join(PATHS.root, "losflow.config.json");
function publicConfig() {
  let envKeys = [];
  try { envKeys = Object.keys(PATHS.windowsClaudeEnv || {}); } catch { /* ignore */ }
  return {
    defaultEnv: PATHS.defaultEnv || "wsl",
    windowsClaudeCmd: PATHS.windowsClaudeCmd || "",
    claudeTimeoutSec: Number(PATHS.claudeTimeoutSec) || 600,
    wslDistro: PATHS.wslDistro || "",
    wslRepo: PATHS.wslRepo || "",
    // 只说明配了哪些变量名，值永远不返回
    windowsClaudeEnvKeys: envKeys,
  };
}
function saveConfig(b) {
  let cur = {};
  try { cur = JSON.parse(readFileSync(configFile(), "utf8")); } catch { cur = {}; }
  if (typeof b.defaultEnv === "string" && (b.defaultEnv === "wsl" || b.defaultEnv === "windows")) {
    cur.defaultEnv = b.defaultEnv;
  }
  if (typeof b.windowsClaudeCmd === "string") cur.windowsClaudeCmd = b.windowsClaudeCmd.trim();
  if (typeof b.claudeTimeoutSec !== "undefined") {
    const n = Number(b.claudeTimeoutSec) || 600;
    cur.claudeTimeoutSec = Math.max(30, Math.min(3600, Math.round(n)));
  }
  writeFileSync(configFile(), JSON.stringify(cur, null, 2) + "\n", "utf8");
  // 运行中的进程立刻生效；PowerShell 每次派单都会重新读配置文件
  PATHS.defaultEnv = cur.defaultEnv === "windows" ? "windows" : "wsl";
  PATHS.windowsClaudeCmd = cur.windowsClaudeCmd || "";
  PATHS.claudeTimeoutSec = Number(cur.claudeTimeoutSec) || 600;
  return { config: publicConfig() };
}

function wbActivityByTask(rows) {
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
// ok=false 表示这次扫描没成功（WSL 不可用等），此时不要据此判定 running.json 过期。
let terminalsCache = { at: 0, data: { count: 0, items: [], ok: false } };
// 历史派单产物：runs/*.json（回执）+ streams/*.jsonl（回放）
function dirStats(dir) {
  let count = 0;
  let bytes = 0;
  try {
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        try {
          const st = statSync(join(dir, f));
          if (st.isFile()) { count += 1; bytes += st.size; }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return { count, bytes };
}

function historyStats() {
  const runs = dirStats(join(PATHS.dataDir, "runs"));
  const streams = dirStats(PATHS.streamsDir || join(PATHS.dataDir, "streams"));
  return { runs: runs.count, streams: streams.count, bytes: runs.bytes + streams.bytes };
}

function purgeHistory(hours) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  let runs = 0;
  for (const dir of [join(PATHS.dataDir, "runs"), PATHS.streamsDir || join(PATHS.dataDir, "streams")]) {
    try {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        try {
          if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); runs += 1; }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
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

let scanBusy = false;
let lastScanAt = 0;

// 本机 Windows 派单：读 data/runstate/*.json，用 process.kill(pid, 0) 探活。
// WSL 的 pid 是 WSL 里的，交给 scan-terminals.sh；两边合并后 items[].env 标明归属。
function scanWindowsRunStates() {
  const items = [];
  const live = new Set();
  for (const st of dispatch.listRunStates()) {
    if (st.env !== "windows") continue;
    if (!dispatch.pidAlive(st.pid)) continue;
    items.push({
      id: String(st.id),
      pid: Number(st.pid) || 0,
      startedAt: st.startedAt || "",
      env: "windows",
      taskId: String(st.taskId || ""),
      repo: st.repo || "",
    });
    live.add(String(st.id));
  }
  return { items, live };
}

async function scanTerminals() {
  // 走脚本文件，不要内联带引号的命令：wsl.exe 会吃掉内层引号
  let items = [];
  let wslOk = false;
  try {
    const r = await runWsl(`bash ${scanScript()}`);
    wslOk = r.code === 0;
    items = String(r.out || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
        const [rawId, pid] = line.split("|");
        const id = String(rawId || "").replace(/^cc-/, "");
        const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(id);
        const startedAt = m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : "";
        return { id, pid: Number(pid) || 0, startedAt, env: "wsl" };
      });
  } catch {
    items = [];
  }

  // 本地 runstate 永远可读；WSL 挂了也不能因此把 Windows 的运行算成「死」
  let local = { items: [] };
  let localOk = false;
  try {
    local = scanWindowsRunStates();
    localOk = true;
  } catch { /* ignore */ }
  items = items.concat(local.items);
  // 异常退出的 runstate 由这里兜底清掉（进程已不在且超过 30 分钟宽限期）
  try { dispatch.pruneRunStates(); } catch { /* ignore */ }
  const ok = wslOk || localOk;
  terminalsCache = { at: Date.now(), data: { count: items.length, items, ok } };
}

// /api/state 永远读缓存，扫描放后台：5s 轮询不再有 100ms 级的 wsl.exe 尖刺。
// 本地 runstate 除外——读目录 + process.kill(pid,0) 成本极低，每次现读，
// 刚起的 Windows 会话立刻出现在终端页，终止后也立刻消失。
function terminalRuns() {
  if (Date.now() - lastScanAt >= 20000 && !scanBusy) {
    scanBusy = true;
    lastScanAt = Date.now();
    scanTerminals().finally(() => {
      scanBusy = false;
    });
  }
  const base = terminalsCache.data;
  let local = { items: [] };
  try { local = scanWindowsRunStates(); } catch { /* ignore */ }
  const items = (base.items || []).filter((x) => x.env !== "windows").concat(local.items);
  return { ...base, count: items.length, items };
}

// running.json 由派单脚本写，脚本被强杀/异常退出时可能留下来（显示「执行中」但早已没有进程）。
// 扫描成功且找不到对应的活 pid、文件又过了宽限期 → 认定过期，删掉，界面自动恢复。
// 宽限期留着是因为 running.json 先写、WSL 里的 pid 文件后建，别在启动瞬间误判。
function liveRunning(running, terminals) {
  if (!running || !running.id) return null;
  if (!terminals || terminals.ok === false) return running;
  const alive = (terminals.items || []).some((x) => String(x.id) === String(running.id));
  if (alive) return running;
  let age = 0;
  try { age = Date.now() - statSync(join(PATHS.dataDir, "running.json")).mtimeMs; } catch { age = 0; }
  if (age < 20000) return running;
  try { unlinkSync(join(PATHS.dataDir, "running.json")); } catch { /* 删不掉就算了，下次再试 */ }
  return null;
}

// 每条任务「实际在跑的 runId」：WSL 里活着的 pid ∩ 台账里该任务最近一条；
// running.json 兜底（会话刚启动、台账还没落行）。这样并发派单时每张卡都认自己的会话。
function liveRunByTask(terminals, running) {
  const live = new Set((terminals?.items || []).map((x) => String(x.id)));
  const map = {};
  // 本机 Windows 的 runstate 自带 taskId：正在跑、台账还没落行时也能认领
  try {
    for (const st of dispatch.liveWindowsRuns()) {
      if (st.taskId) map[String(st.taskId)] = String(st.id);
    }
  } catch { /* ignore */ }
  for (const [taskId, row] of Object.entries(dispatch.latestRunsByTask())) {
    if (row && live.has(String(row.id))) map[taskId] = String(row.id);
  }
  if (running && running.id && running.taskId && (terminals.ok === false || live.has(String(running.id)))) {
    map[String(running.taskId)] = String(running.id);
  }
  return map;
}

// 终端流要推哪些任务：最多 8 条，正在跑的优先，其次最近更新的。
// runId 优先 running.json（刚启动、台账还没写），否则台账里该任务最近一条。
async function streamTargets() {
  const tasks = readJson(FILES.tasks, []) || [];
  const terminals = await terminalRuns();
  const running = readJson(join(PATHS.dataDir, "running.json"), null);
  const latest = dispatch.latestRunsByTask();
  const starts = dispatch.pendingStarts();
  const live = new Set((terminals?.items || []).map((x) => String(x.id)));
  // 本机 Windows 的运行不会写 running.json 之外的地方，且并发时 running.json 只留最后一条；
  // runstate 按 taskId 记着谁在跑，优先用它。
  const localLive = {};
  try {
    for (const st of dispatch.liveWindowsRuns()) {
      if (st.taskId) localLive[String(st.taskId)] = String(st.id);
      live.add(String(st.id));
    }
  } catch { /* ignore */ }
  const isLive = (runId) =>
    !!runId &&
    ((running && String(running.id) === runId) || (terminals.ok !== false && live.has(runId)) || Object.values(localLive).includes(runId));
  const out = [];
  for (const t of tasks) {
    if (t.docOnly) continue;
    const id = String(t.id);
    let runId = "";
    if (localLive[id]) runId = localLive[id];
    else if (running && String(running.taskId || "") === id && running.id) runId = String(running.id);
    else if (latest[id] && latest[id].id) runId = String(latest[id].id);
    if (!runId) continue;
    out.push({
      taskId: id,
      runId,
      live: isLive(runId),
      updatedAt: Number(t.updatedAt) || 0,
      starting: !!starts[id],
    });
  }
  out.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || b.updatedAt - a.updatedAt);
  return out.slice(0, 8);
}

async function buildState() {
  const tasks = readJson(FILES.tasks, []) || [];
  const callRows = readJsonl(FILES.calls, 500);
  const wbMap = wbActivityByTask(callRows);
  const ledger = readJsonl(FILES.ledger, 200);
  const runMap = {};
  for (const r of ledger) {
    const id = String(r.task_id || "");
    if (!id) continue;
    // 列表里只带轻量字段；回执全文（result）走 /api/task/run，别把 state 撑大
    runMap[id] = {
      id: r.id || "",
      at: r.at || "",
      status: r.status || "",
      // 回执缺金额（null）时保持 null，前端显示「—」而不是假的 $0.000
      cost: r.cost_usd === null || r.cost_usd === undefined ? null : Number(r.cost_usd),
      turns: Number(r.turns || 0),
      env: r.env || "wsl",
    };
  }
  const doc = docsync.summary();
  const terminals = await terminalRuns();
  const history = historyStats();
  // 残留的 running.json 会让「标记完成」按钮一直禁用：只认 WSL 里确实活着的会话
  const running = liveRunning(readJson(join(PATHS.dataDir, "running.json"), null), terminals);
  const liveRuns = liveRunByTask(terminals, running);
  const starts = dispatch.pendingStarts();
  const nowMs = Date.now();
  return {
    now: new Date().toISOString(),
    running,
    projects: loadProjects().map(publicProject),
    defaultEnv: defaultEnv(),
    maintenance: loadMaint(),
    pool: pool.loadPool(),
    docsync: doc,
    terminals,
    history,
    approvals: approvals.loadApprovals().slice(-20).reverse(),
    allowlist: approvals.loadAllowlist(),
    notify: notify.status(),
    tasks: tasks.map((t) => {
      const id = String(t.id);
      const st = starts[id];
      // 启动中超过 5 分钟视为残留（脚本异常退出、没来得及清）——前端不再显示「启动中」
      const starting = st && nowMs - Number(st.at || 0) < 5 * 60 * 1000 ? { at: st.at, kind: st.kind || "dispatch" } : null;
      return {
        id,
        subject: t.subject || "",
        owner: t.owner || "",
        status: t.status || "",
        evidence: t.evidence || "",
        note: t.note || "",
        repo: t.repo || "",
        // 派单执行环境：'auto' / 空按 repo 现算，'wsl' / 'windows' 是派单时固化的结果
        env: envOfTask(t),
        envMode: t.env || "auto",
        sessionEnv: t.sessionEnv || "",
        lastError: t.lastError || "",
        lastErrorAt: t.lastErrorAt || null,
        lastErrorStatus: t.lastErrorStatus || "",
        kind: t.kind || "personal",
        // 文档同步类任务：只走 docsync 队列 → WorkBuddy，不进任务页 / 终端页
        docOnly: !!t.docOnly,
        // 人工验收时标注的「类型 / 区域 / 完成时间」（旧任务没有这些字段，缺省为空）
        workType: t.workType || "",
        area: t.area || null,
        finishedAt: t.finishedAt || null,
        wb: wbMap[id] || null,
        updatedAt: t.updatedAt || null,
        sessionId: t.sessionId || "",
        nudgedAt: t.nudgedAt || "",
        nudges: t.nudges || 0,
        docSync: doc.byTask[id] || null,
        starting,
        running: liveRuns[id] || null,
        run: runMap[id] || null,
      };
    }),
    calls: callRows
      .filter((c) => c.kind === "tool")
      .slice(-12)
      .reverse(),
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

// 投递型派单：写「启动中」标记 → 立刻返回 → 后台跑。
// 注意：后台链路必须兜住所有异常，否则 unhandledRejection 会让 Node 直接退出。
async function startDispatch(b, cont) {
  const task = dispatch.getTask(b.id);
  if (!task) throw new Error("没有这条任务");
  assertDispatchable(task);
  if (cont && !task.sessionId) throw new Error("这条任务还没有自己的会话，先点「执行」开一个");
  if (dispatch.isStarting(b.id)) throw new Error("这条正在启动中，稍等（别连点，会重复花费）");
  const env = envOfTask(task);
  // 会话不跨环境：上次是 WSL 的 session_id，这次派到 Windows 就没法续
  const sessionEnv = task.sessionEnv || "";
  const envChanged = !!task.sessionId && !!sessionEnv && sessionEnv !== env;
  if (cont && envChanged) {
    throw new Error(`环境已变（上次 ${sessionEnv}，这次 ${env}），请新开会话`);
  }
  await dispatch.markStarting(b.id, cont ? "continue" : "dispatch");
  // 派单时把判定结果固化到任务上，之后改路径不追溯（改 repo 会重置成 auto）
  await dispatch.setTaskTask(b.id, { env });
  const run = {
    task: b.task || task.note || task.subject,
    mode: cont ? "read" : b.mode === "write" ? "write" : "read",
    allow: b.allow || "",
    repo: task.repo,
    taskId: b.id,
    // 环境变了就不续旧会话（否则 --resume 必失败）；前端据此提示「已开新会话」
    resume: envChanged ? "" : task.sessionId || "",
    env,
  };
  setImmediate(() => {
    dispatch
      .runDispatch(run)
      .then(async (r) => {
        if (r && r.session_id) await dispatch.setTaskTask(b.id, { sessionId: r.session_id, sessionEnv: r.env || env });
        // 回执 ok 才清错误；preflight / error 留在任务上，前端能看见「检查未通过，未产生花费」
        const bad = r && r.status && r.status !== "ok" && r.status !== "deduped";
        if (bad) {
          await dispatch.setTaskTask(b.id, {
            lastError: String(r.error || r.stderr || r.status || "").slice(0, 400),
            lastErrorAt: Date.now(),
            lastErrorStatus: r.status || "",
          });
        } else if (r) {
          await dispatch.setTaskTask(b.id, { lastError: "", lastErrorAt: null, lastErrorStatus: "" });
        }
        syncBrain(b.id, task.subject, r);
      })
      .catch((err) => syncBrain(b.id, task.subject, { status: "failed", error: err.message }))
      .finally(() => dispatch.clearStarting(b.id));
  });
  return { started: true, taskId: String(b.id), env, newSession: envChanged };
}

const ROUTES = {
  "/api/pool/add": (b) => pool.addPool({ title: b.title, note: b.note, kind: b.kind, project: b.project, type: b.type, workType: b.workType }),
  "/api/pool/worktype": (b) => pool.setWorkType({ id: b.id, workType: b.workType }),
  "/api/pool/apply": (b) => pool.applySplit({ id: b.id, subs: b.subs }),
  // 拆分改成后台 job：请求 200 ms 内返回 jobId，后台跑；关弹层 / 切页 / 刷新都不丢结果。
  // 同一池子条目在 running 时再点 → 返回同一个 jobId（reused），不产生第二次花费。
  // 传 sync:1 仍可拿旧行为（等结果），仅供旧前端/排查，下一版删。
  "/api/pool/suggest": async (b) => {
    const item = pool.loadPool().find((x) => x.id === b.id);
    if (!item) throw new Error("没有这条任务");
    const prompt = buildSplitPrompt(item, b.prompt);
    const fallbackOpts = { repo: item.project, env: resolveEnv(item.project, "", defaultEnv()), taskId: item.id, budget: 0.35 };

    if (b.sync) {
      const r = await metaOrDispatch(prompt, fallbackOpts);
      return { dispatch: r.dispatch, raw: r.raw };
    }

    const job = jobs.startJob({
      kind: "pool.suggest",
      key: item.id,
      label: `拆分 · ${item.title}`,
      // 网关 90 s 无响应会先失败；这里再兜一层，保证界面上一定有终态
      timeoutMs: 120 * 1000,
      // 超时收尾：如果已经退回到 Claude Code 派单，且正在跑的就是这条池子条目，顺手停掉
      abort: () => {
        const live = readJson(join(PATHS.dataDir, "running.json"), null);
        if (live && live.id && String(live.taskId || "") === String(item.id)) dispatch.stopRun(live.id);
      },
      run: async () => {
        const r = await metaOrDispatch(prompt, fallbackOpts);
        const raw = String(r.raw || "").trim();
        const st = r.dispatch && r.dispatch.status;
        if (!raw && st && st !== "ok" && st !== "deduped") {
          throw new Error(String(r.dispatch.error || r.dispatch.status || "AI 调用失败"));
        }
        return r;
      },
    });
    return { jobId: job.id, reused: job.reused };
  },
  // 编辑池子条目的「任务本身」（正文）。拆出来的空壳就是靠这个入口补回来。
  "/api/pool/note": (b) => pool.setNote({ id: b.id, note: b.note }),
  // 拆分前的「优化」：把需求补全（不拆），结果写回父条目正文，关弹层也不丢。
  "/api/pool/optimize": async (b) => {
    const item = pool.loadPool().find((x) => x.id === b.id);
    if (!item) throw new Error("没有这条任务");
    const skill = skills.loadSkill("split-optimize");
    const input = [item.title, item.note || ""].filter((x) => String(x || "").trim()).join("\n\n");
    const r = await metaChat(input, skill.body);
    const out = String(r.raw || "").trim();
    if (!r.ok || !out) throw new Error("优化失败：" + String(r.err || "网关没有返回内容").slice(0, 300));
    const saved = await pool.setNote({ id: item.id, note: out });
    return { note: saved.note, via: r.via || "gateway" };
  },
  // 提示词 SKILL：文件在 docs/skills/*.md，可编辑、可 diff、可回滚。
  "/api/skills": (b) => {
    if (b && typeof b.name === "string" && typeof b.content === "string") {
      const saved = skills.saveSkill(b.name, b.content);
      return { skill: publicSkill(saved), preview: skillsPreview() };
    }
    return { skills: skills.listSkills(), preview: skillsPreview() };
  },
  "/api/skills/preview": (b) => {
    const splitSkill = skills.loadSkill("split");
    return {
      prompt: skills.renderSplitPrompt(splitSkill, {
        title: String(b.title || "示例任务标题"),
        note: String(b.note || "示例任务本身（正文）"),
        extra: String(b.extra || ""),
      }),
    };
  },
  "/api/skills/reset": (b) => {
    const s = skills.resetSkill(String(b.name || ""));
    return { skill: publicSkill(s), preview: skillsPreview() };
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
  // 派单环境配置：只写非敏感字段；网关 key 永远不经过接口
  "/api/config": (b) => saveConfig(b),
  "/api/maintenance/config": (b) => {
    const m = loadMaint();
    if (b && typeof b.threshold !== "undefined") m.threshold = Math.max(0, Number(b.threshold) || 0);
    saveMaint(m);
    return { maintenance: m };
  },
  "/api/maintenance/cleanup": async (b) => {
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
    // 整理主表是纯文档活：入 docsync 队列等 WorkBuddy 取走，不建任务行
    const job = await docsync.enqueueMaintenance({ note, docUrl });
    return { docsync: job };
  },
  // 推入 = 两条线：任务本体落库后立刻派单；文档那一行进异步队列（docsync）。
  // 工作 Agent（Claude Code）的任务自动开工，WorkBuddy 的任务等 WB 取走。
  "/api/pool/push": async (b) => {
    const out = await pool.pushPool({ id: b.id, priority: b.priority });
    const autoStarted = [];
    for (const t of out.created) {
      if ((t.owner || "claude-code") !== "claude-code") continue;
      // 兜底：池子里混进文档操作指令时不自动派给 Claude Code
      if (docsync.isDocSyncInstruction([t.subject, t.note].filter(Boolean).join("\n"))) continue;
      autoStarted.push(String(t.id));
      await dispatch.markStarting(t.id, "push");
      setImmediate(() => {
        // 提示词只发「任务本身」：不拼优先级、文档簿记等额外内容
        dispatch
          .runDispatch({ task: t.note, mode: "read", repo: t.repo, taskId: t.id, env: envOfTask(t) })
          .then(async (r) => {
            if (r && r.session_id) await dispatch.setTaskTask(t.id, { sessionId: r.session_id });
            syncBrain(t.id, t.subject, r);
          })
          .catch((err) => syncBrain(t.id, t.subject, { status: "failed", error: err.message }))
          .finally(() => dispatch.clearStarting(t.id));
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
    // 运行态按环境清理：Windows 的 pid 在本地，WSL 的 runstate 只作为路径线索
    const runstate = dispatch.pruneRunStates(hours * 3600 * 1000);
    const jobFiles = jobs.prune(7);
    const liveFiles = approvals.purgeLive(7);
    return { hours, runs, wsl, runstate, jobs: jobFiles, live: liveFiles, left: historyStats() };
  },
  "/api/pool/remove": (b) => pool.removePool(b.id),
  // 终止只作用于「这张卡自己的会话」：前端带上 taskId，服务端按活进程反查 runId。
  // 不带 taskId 的旧前端仍按 running.json 的全局那条处理（留一个版本兼容）。
  "/api/run/stop": async (b) => {
    const taskId = String(b.taskId || "").trim();
    if (!taskId) return dispatch.stopRun();
    const hit = (await streamTargets()).find((x) => x.taskId === taskId && x.live);
    if (!hit) return { stopped: false, note: "这条不在跑（可能已结束或换了会话）" };
    return dispatch.stopRun(hit.runId);
  },
  // 删掉单条历史会话：runstate（Windows 流/pid）+ WSL /tmp 产物 + runs 归档 + 台账行 + 会话指针
  "/api/run/delete": async (b) => {
    const id = String(b.id || "").trim();
    if (!/^[0-9]{8}-[0-9]{6}-[0-9A-Za-z]{6}$/.test(id)) throw new Error("run id 不合法: " + id);
    // 先看这条属于哪个环境：Windows 的产物在 data/runstate，别去 WSL 找
    const st = dispatch.readRunState(id);
    const env = st ? st.env : "";
    let wslFiles = 0;
    if (env !== "windows") {
      const r = await runWsl(`bash ${scanScript()} delete ${id}`);
      const out = String(r.out || "").trim();
      if (out === "ALIVE") throw new Error("这条还在跑，先点「终止」再删");
      if (out.startsWith("BADID")) throw new Error("run id 不合法");
      wslFiles = Number(out) || 0;
    }
    let removedRunstate = false;
    if (st) {
      try { if (st.stream && existsSync(st.stream)) unlinkSync(st.stream); } catch { /* skip */ }
      dispatch.removeRunState(id);
      removedRunstate = true;
    }

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
        await mutate(FILES.tasks, (cur) => {
          const tasks = Array.isArray(cur) ? cur : [];
          let changed = false;
          for (const t of tasks) {
            const hitSession = session && String(t.sessionId || "") === session;
            // 这个任务已经没有别的派单记录了 → 指针一并不留（之后再跑就是新会话）
            const hitTask = b.taskId && String(t.id) === String(b.taskId) && !keepTasks.has(String(b.taskId));
            if (hitSession || hitTask) { t.sessionId = ""; t.sessionEnv = ""; t.updatedAt = Date.now(); changed = true; clearedTasks += 1; }
          }
          return changed ? tasks : undefined;
        });
      } catch { /* skip */ }
    }
    return { id, env, wslFiles, removedRunstate, ledgerRemoved, removedRun, clearedTasks };
  },
  // 投递型接口：只保证「已经开始」，不阻塞到子进程结束（一次派单最长 600 秒）。
  // 立刻返回 {started, taskId}，后台跑完再写回执 / sessionId / 台账。
  "/api/task/continue": (b) => startDispatch(b, true),
  "/api/task/dispatch": (b) => startDispatch(b, false),
  "/api/projects/add": (b) => {
    const name = String(b.name || "").trim();
    const path = String(b.path || "").trim();
    if (!name || !path) throw new Error("名字和路径都要填");
    // env: auto（默认）/ wsl / windows；显式值只在「路径形态与运行环境不一致」时才用
    const mode = String(b.env || "auto").trim().toLowerCase();
    const env = mode === "wsl" || mode === "windows" ? mode : "auto";
    const list = loadProjects();
    if (list.some((x) => x.name === name)) throw new Error("同名项目已存在");
    list.push({ id: "p" + Date.now().toString(36), name, path, env });
    saveProjects(list);
    return { projects: list.map(publicProject), added: publicProject(list[list.length - 1]) };
  },
  "/api/projects/remove": (b) => {
    const list = loadProjects().filter((x) => x.id !== b.id);
    saveProjects(list);
    return { projects: list.map(publicProject) };
  },
  "/api/task/nudge": async (b) => {
    const task = dispatch.getTask(b.id);
    if (!task) throw new Error("没有这条任务");
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
    await dispatch.setTaskTask(b.id, {
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
  // 人工验收：回执 ok 只说明 Claude 跑完了，不等于任务做对了。
  // 工作类型在入池/推入时就定了，这里不再选；只补区域与证据。
  "/api/task/status": async (b) => {
    const task = dispatch.getTask(b.id);
    if (!task) throw new Error("没有这条任务");
    const status = String(b.status || "");
    if (status === "done") {
      const workType = pool.normWorkType(task.workType);
      const raw = b.area && typeof b.area === "object" ? b.area : {};
      const kind = raw.kind === "docs" ? "docs" : workType === "dev" ? "code" : "docs";
      // 代码区默认任务卡上的 repo；文档区必须由人指定路径
      const path = String(raw.path || "").trim() || (kind === "code" ? String(task.repo || "") : "");
      if (kind === "docs" && !path) throw new Error("文档区要指定路径");
      const evidence = String(b.evidence || "").trim() || String(task.evidence || "");
      const t = await dispatch.setTaskTask(b.id, {
        status: "done",
        workType,
        area: { kind, path },
        evidence,
        finishedAt: Date.now(),
      });
      // 回填腾讯文档：一条 update-row（类型 + 区域），WorkBuddy 取到后改状态与备注
      await docsync.enqueueBackfill({ taskId: b.id, subject: t.subject, workType, area: t.area });
      checkAutoCleanup();
      return { task: t };
    }
    if (status === "todo") {
      // 标错了就重新打开：证据、类型、区域都留着，方便再次标记
      return { task: await dispatch.setTaskTask(b.id, { status: "todo", finishedAt: null }) };
    }
    throw new Error("status 只能是 done 或 todo");
  },
  "/api/task/delete": (b) => dispatch.deleteTask(b.id),
  // 任务行的工作类型：推入时已带上；taskboard 建的任务可在这里补/改。
  "/api/task/worktype": async (b) => {
    const t = await dispatch.setTaskTask(b.id, { workType: pool.normWorkType(b.workType) });
    return { task: t, workType: t.workType };
  },
  "/api/prompt/optimize": async (b) => {
    const text = (b.text || "").trim();
    if (!text) throw new Error("提示词为空");
    // 工作类型决定用哪套优化提示词：开发 / 文档 / plan。类型在入池时就定好。
    const task = b.taskId ? dispatch.getTask(b.taskId) : null;
    const workType = pool.normWorkType(b.workType || (task && task.workType));
    const skill = skills.loadSkill(`optimize-${workType}`);
    const fallback = String(loadTemplates().optimizeSystem || "").trim();
    const body = String((skill.error ? fallback : skill.body) || fallback).trim();
    const prompt = skills.renderTextSkill({ body }, text);
    // 元调用不需要仓库：优先直连网关，WSL 停着也能用
    const m = await metaChat(prompt, body);
    if (m.ok && String(m.raw || "").trim()) {
      return { prompt: String(m.raw).trim(), status: "ok", cost: null, via: m.via || "gateway", workType };
    }
    // 网关不可用：退回 Claude Code 派单，把系统提示拼进正文
    const fallbackTask = [body, "", prompt].filter(Boolean).join("\n");
    const r = await dispatch.runDispatch({ task: fallbackTask, mode: "read", taskId: b.taskId });
    const out = String(r.result || "").trim();
    // 失败时别把原文当结果返回：前端会误报「已优化」，看起来就是点了没反应。
    if (!out) {
      const why = r.error || r.stderr || m.err || `status=${r.status || "unknown"}`;
      throw new Error("优化失败：" + String(why).slice(0, 300));
    }
    return { prompt: out, status: r.status, cost: r.cost_usd };
  },
  // 只改 repo 时 env 重置为 auto（按新路径重新判定）；也可显式指定 auto/wsl/windows
  "/api/task/repo": async (b) => {
    const mode = String(b.env || "auto").trim().toLowerCase();
    const env = mode === "wsl" || mode === "windows" ? mode : "auto";
    const t = await dispatch.setTaskTask(b.id, { repo: b.repo, env });
    return { task: t, env: envOfTask(t) };
  },
  "/api/task/docs": async (b) => {
    const prompt = [
      `任务：${b.title}`,
      b.note ? `补充：${b.note}` : "",
      "请输出严格 JSON（不要解释、不要代码块）：",
      '{"requirement":"需求描述（3-5句）","deliverables":["交付事项1","..."],"acceptance":["验收事项1","..."]}',
      "要求：验收事项必须是可逐条勾选验证的动作。",
    ].filter(Boolean).join("\n");
    const task = dispatch.getTask(b.id);
    return metaOrDispatch(prompt, { repo: task && task.repo, env: envOfTask(task || {}), taskId: b.id });
  },
  "/api/task/split": async (b) => {
    const prompt = [
      `把任务拆成 3-6 个子任务：${b.title}`,
      b.note ? `补充：${b.note}` : "",
      "输出严格 JSON 数组（不要解释）：",
      '[{"title":"子任务","owner":"claude-code 或 workbuddy"}]',
    ].filter(Boolean).join("\n");
    const task = dispatch.getTask(b.id);
    return metaOrDispatch(prompt, { repo: task && task.repo, env: envOfTask(task || {}), taskId: b.id });
  },
  "/api/task/optimize": async (b) => {
    const prompt = [
      "把下面这段任务说明改写成给 Claude Code 用的 SKILL.md（含 frontmatter name/description，正文写清四件套）。只输出 SKILL.md 全文。",
      `任务：${b.title}`,
      b.note ? `补充：${b.note}` : "",
    ].filter(Boolean).join("\n");
    const task = dispatch.getTask(b.id);
    const out = await metaOrDispatch(prompt, { repo: task && task.repo, env: envOfTask(task || {}), taskId: b.id });
    return { dispatch: out.dispatch, skill: out.raw || "" };
  },
  "/api/approve": (b) => approvals.approve({ id: b.id, remember: !!b.remember }),
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

  if (req.method === "GET" && url.pathname === "/api/config") {
    return sendJson(res, 200, publicConfig());
  }

  if (req.method === "GET" && url.pathname === "/api/skills") {
    return sendJson(res, 200, { skills: skills.listSkills(), preview: skillsPreview() });
  }

  // 后台作业：拆分等长动作的终态查询。列表只给池子行做徽标，全文走 /api/job?id=
  if (req.method === "GET" && url.pathname === "/api/job") {
    const job = jobs.getJob(url.searchParams.get("id"));
    if (!job) return sendJson(res, 404, { error: "没有这个作业" });
    return sendJson(res, 200, job);
  }
  if (req.method === "GET" && url.pathname === "/api/jobs") {
    const kind = url.searchParams.get("kind") || "";
    return sendJson(res, 200, { jobs: jobs.listJobs({ kind }) });
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
    if (!dispatchId) return sendJson(res, 200, { dispatch: null, lines: [], rounds: [], source: "missing" });

    // v=2：平铺日志契约（12 号方案）。旧前端不带 v 仍走原来的平铺行。
    if (url.searchParams.get("v") === "2") {
      const before = Number(url.searchParams.get("before") || 0) || 0;
      const after = Number(url.searchParams.get("after") || 0) || 0;
      const beforeSeq = Number(url.searchParams.get("beforeSeq") || 0) || 0;
      try {
        const data = await events.readRunRounds(dispatchId, { before, after, beforeSeq });
        return sendJson(res, 200, {
          ...data,
          dispatch: dispatchId,
          running: !!(run && run.id === dispatchId) || data.running,
        });
      } catch (err) {
        return sendJson(res, 200, { dispatch: dispatchId, source: "missing", rounds: [], lines: [], error: err.message });
      }
    }

    return sendJson(res, 200, { dispatch: dispatchId, running: !!(run && run.id === dispatchId), lines: events.readRunRaw(dispatchId) });
  }

  // 原始 stream-json 下载（不做任何解析，排查用）
  if (req.method === "GET" && url.pathname === "/api/task/stream") {
    const id = url.searchParams.get("id");
    const run = readJson(join(PATHS.dataDir, "running.json"), null);
    let dispatchId = run && String(run.taskId || "") === String(id) ? run.id : null;
    if (!dispatchId) {
      const row = dispatch.latestDispatchFor(id);
      dispatchId = row && row.id;
    }
    dispatchId = dispatchId || String(url.searchParams.get("run") || "");
    if (!dispatchId) return sendJson(res, 404, { error: "没有这条会话" });
    const { file } = events.resolveRunFile(dispatchId);
    if (!file) return sendJson(res, 404, { error: "这条会话的原始流已不在（WSL /tmp 已清）" });
    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="${dispatchId}.jsonl"`,
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
    return;
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
  if (req.method === "GET" && url.pathname === "/api/task/run") {
    // 回执全文单独取：/api/state 的 tasks[].run 只带轻量字段，别把列表撑大
    const id = url.searchParams.get("id");
    const row = dispatch.latestDispatchFor(id);
    if (!row) return sendJson(res, 200, { run: null, summary: null });
    // 规则摘要（改了 N 个文件 / N 个错误）供「标记完成」预填证据，读流不在 HTTP 线程里整包解析
    let summary = null;
    try {
      summary = await events.readRunSummary(row.id);
    } catch {
      summary = null;
    }
    return sendJson(res, 200, {
      run: {
        id: row.id || "",
        at: row.at || "",
        status: row.status || "",
        env: row.env || "wsl",
        cost: row.cost_usd === null || row.cost_usd === undefined ? null : Number(row.cost_usd),
        turns: Number(row.turns || 0),
        session: row.session_id || "",
        result: String(row.result || "").slice(0, 4000),
      },
      summary,
    });
  }

  if (req.method === "GET" && url.pathname === "/events/claude") return events.streamClaude(req, res);
  if (req.method === "GET" && url.pathname === "/events/losflow") return events.streamLosflow(req, res, streamTargets);
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
    // 早期 FLOW 原型页（server/index.html）已废弃，不再托管；统一进驾驶舱
    res.writeHead(302, { location: "/app/" });
    return res.end();
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

markLegacyDocTasks();
dispatch.prunePending();
dispatch.pruneRunStates();
// 上次进程被强杀时留下的 running job：统一判失败，界面不装死
jobs.reap();
setInterval(checkAutoCleanup, 60000);
checkAutoCleanup();

server.listen(PORT, "127.0.0.1", () => {
  console.log(`dashboard: http://127.0.0.1:${PORT}`);
});
