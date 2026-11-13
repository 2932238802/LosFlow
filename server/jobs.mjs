// jobs.mjs -- 后台作业（把「等一整次 AI 调用」从 HTTP 请求里挪出去）。
//
// 现状问题：拆分的 /api/pool/suggest 以前在请求里 await 完整次 Claude Code 会话
// （实测 8–19 s，最坏 600 s），弹层又被遮罩独占，看起来就是界面卡死。
// 这里把长动作用 job 表示：POST 立刻返回 jobId，后台跑，前端轮询 /api/job。
//
// 落盘：<dataDir>/jobs/<jobId>.json
//   { id, kind, key, label, status, at, startedAt, doneAt, elapsedMs, result, error, cost, via }
//
//   kind   作业类型（目前只有 pool.suggest）
//   key    幂等键（池子条目 id）：同一条目在 running 时再点，返回同一个 job，不重复花钱
//   status running | ok | failed
//
// 单进程、单人使用：内存里保留一份，写盘只为「刷新/重启后还能看到结果」。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let PATHS = null;
const records = new Map();   // jobId -> record
const timers = new Map();    // jobId -> timeout handle
const aborts = new Map();    // jobId -> () => void（超时时的收尾，比如杀子进程）

const jobsDir = () => join(PATHS.dataDir, "jobs");
const jobFile = (id) => join(jobsDir(), `${id}.json`);

function save(rec) {
  try {
    mkdirSync(jobsDir(), { recursive: true });
    writeFileSync(jobFile(rec.id), JSON.stringify(rec, null, 2), "utf8");
  } catch {
    /* 落盘失败不影响后台任务本身；下次状态变更会再写 */
  }
  records.set(rec.id, rec);
}

function loadFromDisk() {
  const dir = jobsDir();
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (rec && rec.id) records.set(rec.id, rec);
    } catch {
      /* 坏文件跳过 */
    }
  }
}

export function initJobs(paths) {
  PATHS = paths;
  loadFromDisk();
}

function newId() {
  return "j-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 同 kind + key 正在跑的作业：连点 / 关掉弹层再点都只保留一份花费
function findRunning(kind, key) {
  for (const rec of records.values()) {
    if (rec.kind === kind && rec.key === key && rec.status === "running") return rec;
  }
  return null;
}

// 进程被强杀 / 重启后，盘上会留下 running：启动时统一改判 failed，
// 免得界面上永远转圈（和 dispatch.prunePending 一个思路）。
export function reap() {
  let n = 0;
  for (const rec of [...records.values()]) {
    if (rec.status !== "running") continue;
    const doneAt = Date.now();
    save({
      ...rec,
      status: "failed",
      doneAt,
      elapsedMs: doneAt - Number(rec.startedAt || doneAt),
      error: rec.error || "服务重启，这次作业没有跑完，请重新发起",
    });
    n += 1;
  }
  return n;
}

// 7 天清理：和 runs / streams 一个口径，结果全文都会过期。
export function prune(days = 7) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  let n = 0;
  for (const rec of [...records.values()]) {
    if (rec.status === "running") continue;
    const t = Number(rec.doneAt || rec.startedAt || 0);
    if (t && t < cutoff) {
      records.delete(rec.id);
      try { unlinkSync(jobFile(rec.id)); } catch { /* ignore */ }
      n += 1;
    }
  }
  // 盘上有、内存里没有的旧文件也清一遍（比如手删过内存状态）
  const dir = jobsDir();
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const p = join(dir, f);
      try {
        if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); n += 1; }
      } catch { /* ignore */ }
    }
  }
  return n;
}

// 启动一个作业。run 返回字符串（或 {result|raw, cost|cost_usd, via}），做完整条链路后再 resolve。
// timeoutMs > 0 时到点判失败并调用 abort（可选），界面不会无限转圈。
export function startJob({ kind, key, label, run, timeoutMs = 0, abort = null }) {
  const running = findRunning(kind, key);
  if (running) return { id: running.id, reused: true };

  const id = newId();
  const now = Date.now();
  let rec = { id, kind, key, label: String(label || kind || ""), status: "running", at: now, startedAt: now };
  save(rec);

  let settled = false;
  const finish = (patch) => {
    if (settled) return;
    settled = true;
    const t = timers.get(id);
    if (t) { clearTimeout(t); timers.delete(id); }
    aborts.delete(id);
    const doneAt = Date.now();
    rec = {
      ...rec,
      ...patch,
      status: patch.status || "ok",
      doneAt,
      elapsedMs: doneAt - now,
    };
    save(rec);
  };

  setImmediate(async () => {
    try {
      const r = await run();
      const result = typeof r === "string" ? r : String((r && (r.result ?? r.raw)) || "");
      const cost = r && typeof r === "object" ? (r.cost ?? r.cost_usd ?? r.dispatch?.cost ?? null) : null;
      const via = (r && typeof r === "object" && (r.via || r.dispatch?.via)) || "";
      finish({ status: "ok", result, cost, via });
    } catch (e) {
      finish({ status: "failed", error: String((e && e.message) || e || "未知错误") });
    }
  });

  if (timeoutMs > 0) {
    timers.set(
      id,
      setTimeout(() => {
        if (settled) return;
        try { if (abort) abort(); } catch { /* 收尾失败不影响状态 */ }
        finish({
          status: "failed",
          error: `超时（${Math.max(1, Math.round(timeoutMs / 1000))} s）：AI 调用没有回来。检查网关/WSL 是否正常，或到「终端」页看有没有卡住的会话`,
        });
      }, timeoutMs)
    );
    if (abort) aborts.set(id, abort);
  }

  return { id, reused: false };
}

export function getJob(id) {
  const key = String(id || "");
  if (!key) return null;
  const rec = records.get(key);
  if (rec) return { ...rec };
  // 内存里没有（比如别的进程写的 / 重启后首次访问）：按文件捞
  if (existsSync(jobFile(key))) {
    try {
      const r = JSON.parse(readFileSync(jobFile(key), "utf8"));
      records.set(key, r);
      return { ...r };
    } catch { /* ignore */ }
  }
  return null;
}

// 列表只给池子行做徽标用：running 的不带结果（还没生成），终态带全文（约 1 KB）。
export function listJobs({ kind = "" } = {}) {
  const out = [];
  for (const rec of records.values()) {
    if (kind && rec.kind !== kind) continue;
    out.push({ ...rec });
  }
  out.sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  return out.slice(0, 200);
}
