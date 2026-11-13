// approvals.mjs -- Claude Code 权限请求队列（live 实时审批 + legacy 事后审批）。
//
// live（推荐，默认）：
//   1. claude-dispatch.ps1 用 --permission-prompt-tool 指向 agent/approval-mcp.py
//   2. 工具执行前，MCP 写 data/live/<id>.req.json，然后每 200ms 等 <id>.res.json
//   3. 这里 300ms 扫 data/live，把等待中的请求推进 approvals.json（status=pending, live=true），
//      SSE 推给右侧栏
//   4. 人点「只批这次 / 批准并记住 / 拒绝」→ 写 <id>.res.json，同一次 run 继续，不重派
//   5. MCP 收尾归档 req/res；请求消失但记录还 pending → 标记 expired（超时/会话结束）
//
// legacy（兼容旧记录 / live 关闭时）：
//   claude-dispatch.ps1 跑完发现 permission_denials → 写 pending；批准 = 写 allowlist + 重派一次
//
// midRun（降级 C）：
//   运行中的流里出现 permission_decision=reject → 立刻入队（live=false, midRun=true），
//   让人能马上决定是终止还是批准后重派；批准仍然要重派一次。

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import * as notifyPush from "./notify.mjs";

let PATHS = null;
let emit = () => {};
let taskInfo = () => null;
let watcher = null;

export function initApprovals(paths) {
  PATHS = paths;
  try {
    mkdirSync(liveDir(), { recursive: true });
  } catch {
    /* ignore */
  }
}

const approvalsFile = () => join(PATHS.dataDir, "approvals.json");
const allowFile = () => join(PATHS.dataDir, "allowlist.json");
const liveDir = () => join(PATHS.dataDir, "live");
const archiveDir = () => join(liveDir(), "archive");
const reqFile = (id) => join(liveDir(), `${id}.req.json`);
const resFile = (id) => join(liveDir(), `${id}.res.json`);

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, v) {
  writeFileSync(file, JSON.stringify(v, null, 2), "utf8");
}
function writeJsonAtomic(file, v) {
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(v, null, 2), "utf8");
  try {
    renameSync(tmp, file);
  } catch {
    try { unlinkSync(file); } catch { /* ignore */ }
    renameSync(tmp, file);
  }
}

export function loadApprovals() {
  const list = readJson(approvalsFile(), []);
  return Array.isArray(list) ? list : [];
}

export function loadAllowlist() {
  const list = readJson(allowFile(), []);
  return Array.isArray(list) ? list : [];
}

function addRules(rules) {
  const cur = loadAllowlist();
  const set = new Set(cur);
  for (const r of rules || []) if (r) set.add(r);
  writeJson(allowFile(), [...set]);
}

function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function safeId(id) {
  return /^[A-Za-z0-9._:-]+$/.test(String(id || ""));
}

function safeLiveId(rec) {
  const id = String(rec.id || "");
  return rec.live && safeId(id) ? id : "";
}

function notify(action, rec) {
  try {
    emit({ kind: "approval", action, approval: { ...rec } });
  } catch {
    /* SSE 断了不影响落盘 */
  }
}

// ---- live 文件读写 ----
function writeRes(id, decision, message, rules = []) {
  const res = {
    v: 1,
    id,
    decision,
    message: decision === "deny" ? message || "人工拒绝了这次调用" : null,
    rules: decision === "allow" ? rules || [] : [],
    decidedAt: nowStr(),
    decidedBy: "dashboard",
  };
  writeJsonAtomic(resFile(id), res);
  return res;
}

function archiveLive(id) {
  try {
    mkdirSync(archiveDir(), { recursive: true });
    for (const suffix of [".req.json", ".res.json"]) {
      const src = join(liveDir(), id + suffix);
      if (existsSync(src)) {
        try {
          renameSync(src, join(archiveDir(), id + suffix));
        } catch {
          try { unlinkSync(src); } catch { /* ignore */ }
        }
      }
    }
  } catch {
    /* ignore */
  }
}

function liveRecordFromReq(req, prev) {
  const tool = String(req.tool || "");
  const input = req.input && typeof req.input === "object" ? req.input : {};
  let cmd = "";
  try {
    cmd = tool === "Bash" ? String(input.command || "") : JSON.stringify(input).slice(0, 2000);
  } catch {
    cmd = "";
  }
  const timeoutSec = Math.max(5, Number(req.timeoutSec) || 50);
  const atMs = Number(req.atMs) || Date.now();
  const tid = String(req.taskId || prev?.taskId || "");
  let subject = String(prev?.taskSubject || "");
  if (!subject && tid) {
    try {
      const t = taskInfo(tid);
      subject = String((t && t.subject) || "");
    } catch {
      subject = "";
    }
  }
  return {
    ...(prev || {}),
    id: String(req.id),
    at: String(req.at || prev?.at || nowStr()),
    atMs,
    live: true,
    midRun: false,
    runId: String(req.runId || prev?.runId || ""),
    taskId: tid,
    taskSubject: subject,
    tool,
    cmd,
    commands: cmd ? String(cmd).split("\n").filter(Boolean) : [],
    suggested: Array.isArray(req.suggestions) ? req.suggestions : prev?.suggested || [],
    repo: String(req.cwd || prev?.repo || ""),
    env: String(req.env || prev?.env || ""),
    status: "pending",
    expiresAt: atMs + timeoutSec * 1000,
    source: "live",
  };
}

// 把 <id>.res.json 的结果落回记录（server 重启后补状态也走这里）
function applyRes(rec, res) {
  const now = Date.now();
  if (res && res.decision === "allow") {
    rec.status = "approved";
    rec.approvedAt = String(res.decidedAt || nowStr());
  } else {
    rec.status = "rejected";
    rec.rejectedAt = String(res.decidedAt || nowStr());
    rec.rejectNote = String((res && res.message) || "人工拒绝了这次调用");
  }
  rec.decidedAt = String((res && res.decidedAt) || nowStr());
  rec.waitedMs = Math.max(0, now - (Number(rec.atMs) || now));
  return rec;
}

function expire(rec, note) {
  rec.status = "expired";
  rec.expiredAt = nowStr();
  rec.error = note || "等待人工授权超时";
  rec.waitedMs = Math.max(0, Date.now() - (Number(rec.atMs) || Date.now()));
  return rec;
}

// ---- live 扫描 ----
function scanLive() {
  let list = loadApprovals();
  let changed = false;
  const byId = new Map(list.map((r) => [String(r.id), r]));

  let files = [];
  try {
    files = readdirSync(liveDir()).filter((f) => f.endsWith(".req.json"));
  } catch {
    files = [];
  }

  for (const f of files) {
    const req = readJson(join(liveDir(), f), null);
    if (!req || !req.id || !safeId(req.id)) continue;
    const id = String(req.id);
    const prev = byId.get(id);
    if (prev && prev.status !== "pending") continue;
    const next = liveRecordFromReq(req, prev);
    if (!prev) {
      list.push(next);
      byId.set(id, next);
      changed = true;
      notify("waiting", next);
      // 服务端提醒不依赖浏览器是否开着：新请求入队即弹，后续 8s 内的合并计数。
      try {
        const waiting = list.filter((x) => x.status === "pending" && x.live).length;
        notifyPush.notifyApproval(next, { pendingCount: Math.max(1, waiting) });
      } catch {
        /* 通知失败不影响审批队列 */
      }
    } else {
      // 只补空字段：不要在扫的时候把 task 等人工写入的字段覆盖掉
      let touched = false;
      for (const k of ["runId", "taskId", "taskSubject", "tool", "cmd", "repo", "env", "expiresAt", "atMs"]) {
        if (next[k] && prev[k] !== next[k]) { prev[k] = next[k]; touched = true; }
      }
      if (!prev.commands || !prev.commands.length) { prev.commands = next.commands; touched = true; }
      if (!prev.suggested || !prev.suggested.length) { prev.suggested = next.suggested; touched = true; }
      if (touched) changed = true;
    }
  }

  const now = Date.now();
  for (const rec of list) {
    if (!rec.live || rec.status !== "pending") continue;
    const id = safeLiveId(rec);
    if (!id) continue;
    if (existsSync(resFile(id))) {
      // 之前进程写了 res 但没来得及落状态（或两个 dashboard 实例）
      const res = readJson(resFile(id), null);
      if (res) {
        applyRes(rec, res);
        changed = true;
        notify(rec.status === "approved" ? "approved" : "rejected", rec);
        notifyPush.forgetApproval(id);
      }
      continue;
    }
    if (!existsSync(reqFile(id))) {
      // MCP 已收尾（批准/拒绝/超时都会删 req）；记录还 pending 说明服务没收到结论
      expire(rec, rec.error || "请求已结束（超时或会话停止），没有拿到人的决定");
      changed = true;
      notify("expired", rec);
      notifyPush.forgetApproval(id);
      archiveLive(id);
      continue;
    }
    const deadline = Number(rec.expiresAt) || 0;
    if (deadline && now > deadline + 3000) {
      // 双保险：MCP 自己也会超时；这里先落 deny，避免卡片永远转圈
      try { writeRes(id, "deny", "等待人工授权超时，按拒绝处理；不要换个写法重试，先向用户说明"); } catch { /* ignore */ }
      expire(rec, "等待人工授权超时，按拒绝处理");
      changed = true;
      notify("expired", rec);
      notifyPush.forgetApproval(id);
    }
  }

  if (changed) writeJson(approvalsFile(), list);
}

export function startLiveWatch(onEvent, resolveTask) {
  if (typeof onEvent === "function") emit = onEvent;
  if (typeof resolveTask === "function") taskInfo = resolveTask;
  try { mkdirSync(liveDir(), { recursive: true }); } catch { /* ignore */ }
  if (watcher) return;
  scanLive();
  watcher = setInterval(scanLive, 300);
  if (watcher.unref) watcher.unref();
}

export function stopLiveWatch() {
  if (watcher) clearInterval(watcher);
  watcher = null;
}

// 7 天清理：live 与 archive 里的旧文件
export function purgeLive(days = 7) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  let n = 0;
  for (const dir of [liveDir(), archiveDir()]) {
    try {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        try {
          if (statSync(p).isFile() && statSync(p).mtimeMs < cutoff) { unlinkSync(p); n += 1; }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  return n;
}

// ---- 人工决定 ----
export function approve({ id, remember = false }) {
  const list = loadApprovals();
  const rec = list.find((x) => x.id === id);
  if (!rec) throw new Error("没有这条授权请求: " + id);
  if (rec.status !== "pending") throw new Error("已经处理过了: " + rec.status);

  if (rec.live) {
    const liveId = safeLiveId(rec);
    if (!liveId || !existsSync(reqFile(liveId))) {
      expire(rec, "请求已结束，无法再放行");
      writeJson(approvalsFile(), list);
      notify("expired", rec);
      throw new Error("这次请求已经结束（超时或会话已停止），没有放行");
    }
    const rules = remember ? [...(rec.suggested || [])] : [];
    if (remember && rules.length) addRules(rules);
    writeRes(liveId, "allow", null, rules);
    rec.status = "approved";
    rec.approvedAt = nowStr();
    rec.decidedAt = rec.approvedAt;
    rec.remembered = !!remember;
    rec.waitedMs = Math.max(0, Date.now() - (Number(rec.atMs) || Date.now()));
    writeJson(approvalsFile(), list);
    notify("approved", rec);
    notifyPush.forgetApproval(id);
    return {
      id,
      live: true,
      remembered: !!remember,
      rules,
      retry: { started: false, note: "已放行，同一次运行继续执行（不重派）" },
    };
  }

  // legacy：跑完之后的事故报告，只能写 allowlist + 重派一次
  const rules = [...(rec.suggested || [])];
  addRules(rules);

  rec.status = "approved";
  rec.approvedAt = nowStr();
  writeJson(approvalsFile(), list);

  const retry = retryDispatch(rec);
  rec.retriedAt = retry.started ? nowStr() : null;
  rec.retryNote = retry.note;
  writeJson(approvalsFile(), list);
  notify("approved", rec);
  notifyPush.forgetApproval(id);

  return { id, rules, retry };
}

export function reject({ id }) {
  const list = loadApprovals();
  const rec = list.find((x) => x.id === id);
  if (!rec) throw new Error("没有这条授权请求: " + id);
  if (rec.status !== "pending") throw new Error("已经处理过了: " + rec.status);

  if (rec.live) {
    const liveId = safeLiveId(rec);
    if (liveId && existsSync(reqFile(liveId))) {
      writeRes(liveId, "deny", "人工拒绝；不要换个写法重试，先向用户说明卡在哪里");
    }
    rec.status = "rejected";
    rec.rejectedAt = nowStr();
    rec.decidedAt = rec.rejectedAt;
    rec.rejectNote = "人工拒绝；不要换个写法重试，先向用户说明卡在哪里";
    rec.waitedMs = Math.max(0, Date.now() - (Number(rec.atMs) || Date.now()));
    writeJson(approvalsFile(), list);
    notify("rejected", rec);
    notifyPush.forgetApproval(id);
    return { id, live: true, note: "已拒绝，同一次运行会收到拒绝理由继续跑" };
  }

  rec.status = "rejected";
  rec.rejectedAt = nowStr();
  writeJson(approvalsFile(), list);
  notify("rejected", rec);
  return { id };
}

// 降级 C：运行中的流里发现 permission_decision=reject，立刻入队。
// live 审批生效时不会走到这里；live 关闭 / MCP 不可用时，人至少能马上决定要不要停。
export function recordMidRunDenial({ runId = "", taskId = "", tool = "", input = null, toolUseId = "", text = "", task = "", repo = "", env = "", mode = "read", allow = "" }) {
  const rid = String(runId || "");
  const uid = String(toolUseId || "");
  if (!rid || !uid) return null;
  const list = loadApprovals();
  if (list.some((x) => x.runId === rid && x.toolUseId === uid)) return null;

  let cmd = "";
  try {
    cmd = tool === "Bash" ? String((input && input.command) || "") : JSON.stringify(input || {}).slice(0, 2000);
  } catch {
    cmd = "";
  }
  const suggested = [];
  if (tool === "Bash" && cmd) {
    const parts = cmd.trim().split(/\s+/);
    if (parts.length >= 2) suggested.push(`Bash(${parts[0]} ${parts[1]}:*)`);
    else if (parts.length === 1) suggested.push(`Bash(${parts[0]}:*)`);
  }
  const rec = {
    id: "ap-mid-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    at: nowStr(),
    runId: rid,
    taskId: String(taskId || ""),
    tool: String(tool || ""),
    toolUseId: uid,
    cmd,
    commands: cmd ? cmd.split("\n").filter(Boolean) : [],
    suggested,
    task,
    mode,
    allow,
    repo,
    env,
    status: "pending",
    live: false,
    midRun: true,
    note: "这次运行还在继续；批准会写入 allowlist，并按原任务重派一次",
    rejectText: String(text || "").slice(0, 500),
  };
  list.push(rec);
  writeJson(approvalsFile(), list);
  notify("waiting", rec);
  try { notifyPush.notifyApproval(rec, { pendingCount: 1 }); } catch { /* ignore */ }
  return rec;
}

function retryDispatch(rec) {
  if (rec.retriedAt) return { started: false, note: "已经重派过" };
  if (!rec.task) return { started: false, note: "没有任务正文，无法重派" };

  const tmp = PATHS.tempDir || "D:\\Temp";
  if (!existsSync(tmp)) mkdirSync(tmp, { recursive: true });
  const taskFile = join(tmp, `claude-retry-${rec.id}.md`);
  writeFileSync(taskFile, rec.task, "utf8");

  const script = join(PATHS.agentDir, "claude-dispatch.ps1");
  // 只在被拒的那一侧重派：env 决定 runner，repo 决定工作目录
  const env = rec.env === "windows" ? "windows" : rec.env === "wsl" ? "wsl" : "";
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-TaskFile",
    taskFile,
    "-Mode",
    rec.mode || "read",
  ];
  if (env) args.push("-Env", env);
  if (rec.repo) args.push("-Repo", rec.repo);
  if (PATHS.dataDir) args.push("-OutDir", PATHS.dataDir);
  if (env !== "windows" && PATHS.wslDistro) args.push("-Distro", PATHS.wslDistro);
  if (rec.allow) args.push("-Allow", rec.allow);

  const logPath = join(tmp, `claude-retry-${rec.id}.log`);
  try {
    const fd = openSync(logPath, "w");
    // 注意：Windows 上不能用 detached，DETACHED_PROCESS 会让子进程的 stdio 句柄继承失效
    const child = spawn("powershell.exe", args, {
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    closeSync(fd);
    child.unref();
    return { started: true, note: `已按原任务重派（pid ${child.pid}，日志 ${logPath}）` };
  } catch (err) {
    return { started: false, note: "重派失败: " + err.message };
  }
}
