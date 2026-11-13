// dispatch.mjs -- 驾驶舱点按钮时，由后端代为派单/终止。
//
// 所有 AI 动作都走 claude-dispatch.ps1（保持同一条认证与成本路径），
// 唯一例外是「终止」：直接杀掉正在跑的那个 bash 进程。

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";

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

function readJson(f, d) {
  try {
    if (!existsSync(f)) return d;
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return d;
  }
}
function writeJson(f, v) {
  writeFileSync(f, JSON.stringify(v, null, 2), "utf8");
}

// 跑一次派单，返回解析后的回执对象
export function runDispatch({ task, mode = "read", allow = "", repo = "", taskId = "", cont = false, resume = "", force = true, budget = 0 }) {
  return new Promise((resolve) => {
    // 任务正文走临时文件：多行文本直接当命令行参数会破坏 Windows 的引号解析
    const tmpDir = PATHS.tempDir || "D:\\Temp";
    const taskFile = join(tmpDir, `dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
    writeFileSync(taskFile, String(task || ""), "utf8");

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
    ];
    if (mode === "write") args.push("-Mode", "write");
    if (allow) args.push("-Allow", allow);
    if (repo) args.push("-Repo", repo);
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
      const line = out.split("\n").reverse().find((l) => l.trim().startsWith("{"));
      if (!line) return resolve({ status: "unparsed", error: (err || out).slice(-400) });
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ status: "unparsed", error: "json parse failed" });
      }
    });
  });
}

// 终止正在跑的 Claude Code
export function stopRun() {
  const run = readJson(runningFile(), null);
  if (!run || !run.id) return { stopped: false, note: "没有正在跑的派单" };
  const pidFile = `/tmp/cc-${run.id}.pid`;
  const cmd = `p=\\$(cat ${pidFile} 2>/dev/null); if [ -n "\\$p" ]; then kill -TERM \\$p 2>/dev/null; sleep 0.5; kill -KILL \\$p 2>/dev/null || true; echo KILLED; else echo NOPID; fi`;
  const child = spawn("wsl.exe", ["-d", PATHS.wslDistro, "--", "bash", "-lc", cmd]);
  let out = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.on("close", () => {
    /* 结果通过返回值同步不了，下面用同步方式兜底 */
  });
  return { stopped: true, note: `已发送终止信号：${run.id}` };
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

export function deleteTask(id) {
  const tasks = readJson(tasksFile(), []);
  const next = tasks.filter((x) => String(x.id) !== String(id));
  if (next.length === tasks.length) throw new Error("没有这条任务: " + id);
  writeJson(tasksFile(), next);
  return { deleted: id };
}

export function setTaskTask(id, patch) {
  const tasks = readJson(tasksFile(), []);
  const t = tasks.find((x) => String(x.id) === String(id));
  if (!t) throw new Error("没有这条任务: " + id);
  Object.assign(t, patch, { updatedAt: Date.now() });
  writeJson(tasksFile(), tasks);
  return t;
}
