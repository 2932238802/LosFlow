// dispatch.mjs -- 驾驶舱点按钮时，由后端代为派单/终止。
//
// 所有 AI 动作都走 claude-dispatch.ps1（保持同一条认证与成本路径），
// 唯一例外是「终止」：直接杀掉正在跑的那个 bash 进程。

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync, openSync, closeSync, copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJson as readJsonFile, mutate } from "./store.mjs";
import { resolveEnv } from "./env.mjs";

let PATHS = null;
export function initDispatch(paths) {
  PATHS = paths;
}

// 读子进程输出：优先 UTF-8；解出替换符说明上游按本地代码页（GBK）写了，退回去再解一次。
function decodeMaybe(buf) {
  const utf8 = buf.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    const gbk = new TextDecoder("gbk").decode(buf);
    // 谁替换符少用谁
    return (gbk.match(/\uFFFD/g) || []).length < (utf8.match(/\uFFFD/g) || []).length ? gbk : utf8;
  } catch {
    return utf8;
  }
}

const runningFile = () => join(PATHS.dataDir, "running.json");
const tasksFile = () => join(PATHS.dataDir, "Vesta.tasks.json");
const pendingFile = () => join(PATHS.dataDir, "pending.json");
const runstateDir = () => PATHS.runstateDir || join(PATHS.dataDir, "runstate");

function readJson(f, d) {
  return readJsonFile(f, d);
}

// ---- 每次派单的运行态 ----
// 全局 running.json 只记最后一条，是「终止 / 终端页」串台的根。这里改成 per-run:
//   data/runstate/<runId>.json = { id, taskId, env, repo, stream, pid, startedAt, claudeVersion }
// 由 runner 在 preflight 通过后写，派单结束后由 archiveStream 删；异常退出由 pruneRunStates 兜底。
export function readRunState(runId) {
  const id = String(runId || "");
  if (!id) return null;
  const file = join(runstateDir(), `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function removeRunState(runId) {
  try {
    const file = join(runstateDir(), `${String(runId || "")}.json`);
    if (existsSync(file)) unlinkSync(file);
  } catch { /* ignore */ }
}

export function listRunStates() {
  const dir = runstateDir();
  const out = [];
  try {
    if (!existsSync(dir)) return out;
    for (const f of readdirSync(dir)) {
      // <id>.json 才是运行态；Windows 非流模式的回执叫 <id>.out.json，别混进来
      if (!f.endsWith(".json") || f.endsWith(".out.json")) continue;
      try {
        const st = JSON.parse(readFileSync(join(dir, f), "utf8"));
        if (!st || !st.id) st.id = f.replace(/\.json$/, "");
        st._file = join(dir, f);
        st._mtime = statSync(join(dir, f)).mtimeMs;
        out.push(st);
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return out;
}

// Windows 进程探活：pid 存在即可（EPERM 说明进程在、只是不归我们管）
export function pidAlive(pid) {
  const p = Number(pid) || 0;
  if (p <= 0) return false;
  try {
    process.kill(p, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}

// 只在跑在本机的 Windows 派单可据此认定「活着」；WSL 的 pid 是 WSL 内的，由 scan-terminals.sh 负责
export function liveWindowsRuns() {
  return listRunStates().filter((st) => st.env === "windows" && pidAlive(st.pid));
}

// 过期 runstate 清理：进程已不在且文件超过宽限期（默认 30 分钟）
export function pruneRunStates(maxAgeMs = 30 * 60 * 1000) {
  const now = Date.now();
  let removed = 0;
  for (const st of listRunStates()) {
    if (st.env === "windows" && pidAlive(st.pid)) continue;
    if (now - Number(st._mtime || 0) >= maxAgeMs) {
      removeRunState(st.id);
      removed += 1;
    }
  }
  return removed;
}

export function resolveDispatchEnv(repo, mode) {
  return resolveEnv(repo, mode === "auto" ? "" : mode, PATHS.defaultEnv || "wsl");
}

// 跑一次派单，返回解析后的回执对象。
// env 由调用方按 task.repo / task.env 解析后传入；不传就按 repo 现算（老调用方兼容）。
export function runDispatch({ task, mode = "read", allow = "", repo = "", taskId = "", cont = false, resume = "", force = true, budget = 0, env = "" }) {
  return new Promise((resolve) => {
    // 任务正文走临时文件：多行文本直接当命令行参数会破坏 Windows 的引号解析
    const tmpDir = PATHS.tempDir || "D:\\Temp";
    const taskFile = join(tmpDir, `dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
    writeFileSync(taskFile, String(task || ""), "utf8");
    const dispatchEnv = env === "wsl" || env === "windows" ? env : resolveDispatchEnv(repo, "");

    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(PATHS.agentDir, "claude-dispatch.ps1"),
      "-TaskFile",
      taskFile,
      "-JsonOut",
      "-Stream",
      "-NoApproval",
      "-Env",
      dispatchEnv,
    ];
    if (mode === "write") args.push("-Mode", "write");
    if (allow) args.push("-Allow", allow);
    if (repo) args.push("-Repo", repo);
    else if (dispatchEnv === "wsl" && PATHS.wslRepo) args.push("-Repo", PATHS.wslRepo);
    if (PATHS.dataDir) args.push("-OutDir", PATHS.dataDir);
    if (PATHS.wslDistro) args.push("-Distro", PATHS.wslDistro);
    if (PATHS.claudeTimeoutSec) args.push("-TimeoutSec", String(PATHS.claudeTimeoutSec));
    if (taskId) args.push("-TaskId", String(taskId));
    if (cont && !resume) args.push("-Continue");
    if (resume) args.push("-Resume", String(resume));
    if (force) args.push("-Force");
    if (budget > 0) args.push("-MaxBudget", String(budget));

    // 用文件接输出：某些受限环境里不能给子进程开管道，否则直接 EPERM
    const outFile = taskFile + ".out";
    const errFile = taskFile + ".err";
    const fdOut = openSync(outFile, "w");
    const fdErr = openSync(errFile, "w");
    const child = spawn("powershell.exe", args, { windowsHide: true, stdio: ["ignore", fdOut, fdErr] });
    closeSync(fdOut);
    closeSync(fdErr);
    child.on("error", (e) => resolve({ status: "error", error: "spawn: " + e.message }));
    child.on("close", () => {
      let out = "";
      let err = "";
      try {
        // 兜底：万一 PowerShell 那边没走 UTF-8（旧版本脚本 / 环境差异），这里再按 GBK 解一次，
        // 否则中文全变成 U+FFFD，界面上一片乱码。
        const buf = readFileSync(outFile);
        out = decodeMaybe(buf);
        err = decodeMaybe(readFileSync(errFile));
      } catch { /* ignore */ }
      for (const f of [taskFile, outFile, errFile]) { try { unlinkSync(f); } catch { /* ignore */ } }
      // 派单结束（成功/失败都算）：把 stream-json 抄进 data/streams，
      // 否则 WSL 重启或 /tmp 被清后，历史会话点开就是空白。
      // Windows 的临时流在 data/runstate 下，抄完就删；runstate 一并清掉。
      const finish = (receipt) => {
        let runId = receipt && receipt.id ? String(receipt.id) : "";
        if (!runId) {
          const live = readJson(runningFile(), null);
          if (live && live.id && (!taskId || String(live.taskId || "") === String(taskId))) runId = String(live.id);
        }
        if (runId) archiveStream(runId, receipt && receipt.env);
        resolve(receipt);
      };
      const line = out.split("\n").reverse().find((l) => l.trim().startsWith("{"));
      if (!line) return finish({ status: "unparsed", error: (err || out).slice(-400) });
      try {
        finish(JSON.parse(line));
      } catch {
        finish({ status: "unparsed", error: "json parse failed" });
      }
    });
  });
}

// 把一次派单的 stream-json 归档到 data/streams/<id>.jsonl。
// 来源按「runstate 里记的 stream → runstate 默认名 → WSL /tmp」依次找；Windows 的临时流
// 抄完就删，runstate 无论成功与否都清掉（派单已经结束）。
export function archiveStream(runId, envHint = "") {
  const id = String(runId || "");
  if (!id) return "";
  const dir = PATHS.streamsDir || join(PATHS.dataDir, "streams");
  const st = readRunState(id);
  const env = (st && st.env) || (envHint === "windows" ? "windows" : envHint === "wsl" ? "wsl" : "");
  const srcs = [];
  if (st && st.stream) srcs.push(st.stream);
  if (env !== "wsl") srcs.push(join(runstateDir(), `${id}.stream.jsonl`));
  srcs.push(`\\\\wsl.localhost\\${PATHS.wslDistro}\\tmp\\cc-${id}.stream.jsonl`);
  let copied = "";
  try {
    for (const src of srcs) {
      if (!src || !existsSync(src)) continue;
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, `${id}.jsonl`);
      copyFileSync(src, dest);
      copied = dest;
      // 归档成功后删掉 Windows 侧的临时流（WSL /tmp 由 purge 管，别动）
      if (env === "windows" && src !== dest) {
        try { unlinkSync(src); } catch { /* ignore */ }
      }
      break;
    }
  } catch {
    copied = "";
  }
  // Windows runner 的临时产物（流 / 回执 / stderr / 任务正文）抄完就删，runstate 目录不留垃圾
  if (env === "windows") {
    for (const name of [`${id}.stream.jsonl`, `${id}.out.json`, `${id}.err`, `${id}.task.md`, `${id}.mcp.json`]) {
      try {
        const p = join(runstateDir(), name);
        if (existsSync(p) && p !== copied) unlinkSync(p);
      } catch { /* ignore */ }
    }
  }
  removeRunState(id);
  return copied;
}

function killWindowsTree(pid) {
  return new Promise((resolve) => {
    const p = Number(pid) || 0;
    if (!p || !pidAlive(p)) return resolve(false);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(true);
    }, 8000);
    const child = spawn("taskkill.exe", ["/T", "/F", "/PID", String(p)], { windowsHide: true });
    child.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // taskkill 失败但进程确实没了，也算成功
      finish(code === 0 || !pidAlive(p));
    });
  });
}

// 终止一个正在跑的 Claude Code。runId 由调用方按「这条任务实际的活会话」解析后传入；
// 不传时退回 running.json（全局最后一个），仅用于旧前端兼容。
// 环境不同，终止方式不同：Windows 按 runstate 里的 pid 杀进程树；WSL 按 /tmp 里的 pid。
export function stopRun(runId = "") {
  const id = String(runId || (readJson(runningFile(), null)?.id || ""));
  if (!id) return Promise.resolve({ stopped: false, note: "没有正在跑的派单" });
  const st = readRunState(id);
  if (st && st.env === "windows") {
    return killWindowsTree(st.pid).then((ok) => ({
      stopped: ok,
      id,
      env: "windows",
      note: ok ? `已终止：${id}（Windows）` : `没找到进程（可能已自己结束）：${id}`,
    }));
  }
  const pidFile = `/tmp/cc-${id}.pid`;
  const cmd = `p=\\$(cat ${pidFile} 2>/dev/null); if [ -n "\\$p" ]; then kill -TERM \\$p 2>/dev/null; sleep 0.5; kill -KILL \\$p 2>/dev/null || true; echo KILLED; else echo NOPID; fi`;
  return new Promise((resolve) => {
    const child = spawn("wsl.exe", ["-d", PATHS.wslDistro, "--", "bash", "-lc", cmd], { windowsHide: true });
    let out = "";
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ stopped: true, id, env: "wsl", note: `已发送终止信号：${id}（等不到 WSL 回执）` });
    }, 8000);
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      finish({ stopped: false, id, env: "wsl", note: `终止失败：${e.message}` });
    });
    child.on("close", () => {
      clearTimeout(timer);
      const r = out.trim();
      finish({
        stopped: r !== "NOPID",
        id,
        env: "wsl",
        note: r === "KILLED" ? `已终止：${id}` : r === "NOPID" ? `没找到进程（可能已自己结束）：${id}` : `已发送终止信号：${id}`,
      });
    });
  });
}

// ---- 启动中标记 ----
// 派单异步化后，「点了按钮 → 子进程真正写 running.json」之间有一段空窗。
// 这段空窗写进 pending.json，/api/state 据此显示「执行中（启动中）」。
export async function markStarting(taskId, kind = "dispatch") {
  const id = String(taskId);
  await mutate(pendingFile(), (cur) => {
    const next = cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {};
    next[id] = { at: Date.now(), kind };
    return next;
  });
}

export function clearStarting(taskId) {
  const id = String(taskId);
  return mutate(pendingFile(), (cur) => {
    const next = cur && typeof cur === "object" && !Array.isArray(cur) ? { ...cur } : {};
    delete next[id];
    return next;
  }).catch(() => undefined);
}

export function pendingStarts() {
  const raw = readJson(pendingFile(), {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

export function isStarting(taskId) {
  return Object.prototype.hasOwnProperty.call(pendingStarts(), String(taskId));
}

// 启动中标记的宽限期（与 buildState 的显示口径一致）：超过就不再认，避免崩过一次后永久卡住
export async function prunePending(maxAgeMs = 5 * 60 * 1000) {
  const now = Date.now();
  await mutate(pendingFile(), (cur) => {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return {};
    const next = {};
    let changed = false;
    for (const [k, v] of Object.entries(cur)) {
      if (now - Number(v && v.at) < maxAgeMs) next[k] = v;
      else changed = true;
    }
    return changed ? next : cur;
  }).catch(() => undefined);
}

// 台账按 taskId 归并成「最近一条」，只读一遍文件。
export function latestRunsByTask() {
  const map = {};
  const ledger = join(PATHS.dataDir, "claude-ledger.jsonl");
  if (!existsSync(ledger)) return map;
  try {
    const lines = readFileSync(ledger, "utf8").split("\n").filter(Boolean);
    for (const l of lines) {
      try {
        const r = JSON.parse(l);
        const id = String(r.task_id || "");
        if (id) map[id] = r;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return map;
}

// 找出某条任务对应的最近一次派单（用 ledger 里 task 文本模糊匹配）
export function latestDispatchFor(taskId) {
  const ledger = join(PATHS.dataDir, "claude-ledger.jsonl");
  if (!existsSync(ledger)) return null;
  const lines = readFileSync(ledger, "utf8").split("\n").filter(Boolean).reverse();
  for (const l of lines) {
    try {
      const r = JSON.parse(l);
      if (String(r.task_id || "") === String(taskId)) return r;
    } catch { /* skip */ }
  }
  return null;
}

export function lastDispatchFor(taskId) {
  const tasks = readJson(tasksFile(), []);
  const t = tasks.find((x) => String(x.id) === String(taskId));
  if (!t) return null;
  const ledger = join(PATHS.dataDir, "claude-ledger.jsonl");
  if (!existsSync(ledger)) return null;
  const lines = readFileSync(ledger, "utf8").split("\n").filter(Boolean).reverse();
  const needle = (t.subject || "").slice(0, 12);
  for (const l of lines) {
    try {
      const r = JSON.parse(l);
      if (r.status === "ok" && (r.task_preview || "").includes(needle)) return r;
    } catch {
      /* skip */
    }
  }
  return null;
}

export function getTask(id) {
  return readJson(tasksFile(), []).find((x) => String(x.id) === String(id)) || null;
}

export async function deleteTask(id) {
  const tid = String(id);
  const next = await mutate(tasksFile(), (tasks) => {
    const list = Array.isArray(tasks) ? tasks : [];
    if (!list.some((x) => String(x.id) === tid)) throw new Error("没有这条任务: " + id);
    return list.filter((x) => String(x.id) !== tid);
  });
  return { deleted: tid, left: next.length };
}

export async function setTaskTask(id, patch) {
  const tid = String(id);
  let found = null;
  await mutate(tasksFile(), (tasks) => {
    const list = Array.isArray(tasks) ? tasks : [];
    const t = list.find((x) => String(x.id) === tid);
    if (!t) throw new Error("没有这条任务: " + id);
    Object.assign(t, patch, { updatedAt: Date.now() });
    found = t;
    return list;
  });
  return found;
}
