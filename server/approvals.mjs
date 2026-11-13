// approvals.mjs -- Claude Code 权限请求队列。
//
// 流程：
//   1. claude-dispatch.ps1 跑完发现 permission_denials → 往 _progress/approvals.json 写一条 pending
//   2. 仪表盘把它列出来（命令原文 + 建议放行的规则）
//   3. 点「批准」→ 规则进 _progress/allowlist.json（以后同类活不再问）+ 自动按原任务重派一次
//   4. 点「拒绝」→ 记录 rejected，不重派
//
// 批准后重派只做一次（retriedAt 存在就不再派），避免循环。

import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

let PATHS = null;
export function initApprovals(paths) {
  PATHS = paths;
}

const approvalsFile = () => join(PATHS.dataDir, "approvals.json");
const allowFile = () => join(PATHS.dataDir, "allowlist.json");

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

export function approve({ id }) {
  const list = loadApprovals();
  const rec = list.find((x) => x.id === id);
  if (!rec) throw new Error("没有这条授权请求: " + id);
  if (rec.status !== "pending") throw new Error("已经处理过了: " + rec.status);

  const rules = [...(rec.suggested || [])];
  addRules(rules);

  rec.status = "approved";
  rec.approvedAt = nowStr();
  writeJson(approvalsFile(), list);

  const retry = retryDispatch(rec);
  rec.retriedAt = retry.started ? nowStr() : null;
  rec.retryNote = retry.note;
  writeJson(approvalsFile(), list);

  return { id, rules, retry };
}

export function reject({ id }) {
  const list = loadApprovals();
  const rec = list.find((x) => x.id === id);
  if (!rec) throw new Error("没有这条授权请求: " + id);
  rec.status = "rejected";
  rec.rejectedAt = nowStr();
  writeJson(approvalsFile(), list);
  return { id };
}

function retryDispatch(rec) {
  if (rec.retriedAt) return { started: false, note: "已经重派过" };
  if (!rec.task) return { started: false, note: "没有任务正文，无法重派" };

  const tmp = PATHS.tempDir || "D:\\Temp";
  if (!existsSync(tmp)) mkdirSync(tmp, { recursive: true });
  const taskFile = join(tmp, `claude-retry-${rec.id}.md`);
  writeFileSync(taskFile, rec.task, "utf8");

  const script = join(PATHS.agentDir, "claude-dispatch.ps1");
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
