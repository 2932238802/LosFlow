// notify.mjs -- 授权请求的 Windows 桌面提醒（NotifyIcon 气球 + 声音）。
//
// 为什么在服务端：浏览器可能最小化 / 面板收起 / iframe 在后台，页面内提示
// 没人看得见。服务端在新 live 请求入队那一刻就 spawn 一次 PowerShell，
// 不依赖浏览器是否开着。
//
// 选型（12 号文档 5.2 实测）：WinRT ToastNotificationManager 在未打包进程里
// 会 0x80073D54（没有 package identity）；System.Windows.Forms.NotifyIcon
// .ShowBalloonTip 可用。中文通过 -PayloadB64 传入，脚本本体保持 ASCII。
//
// 去重 / 节流：
//   - 同一 approval id 只主动响一次；repeatAfterMs 后若还没处理再响一次；
//   - 全局 minIntervalMs（默认 8s）内的新请求合并成「AUTH N 条等你批」；
//   - 批准 / 拒绝 / 过期后 repeat 自动跳过（isPending 回调判断）。

import { spawn } from "node:child_process";
import { join } from "node:path";

let PATHS = null;
let opts = { isPending: () => false };
let cfg = { enabled: true, mode: "auto", sound: true, minIntervalMs: 8000, repeatAfterMs: 20000 };
let ok = null;
let lastAt = 0;
let lastError = "";
let spawning = false;
let flushTimer = 0;
const seen = new Set();
const pending = new Map();
const repeats = new Map();

function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function initNotify(paths, options = {}) {
  PATHS = paths;
  if (typeof options.isPending === "function") opts.isPending = options.isPending;
  const raw = (paths && paths.notify) || {};
  cfg = {
    enabled: raw.enabled !== false && raw.enabled !== "false",
    mode: String(raw.mode || "auto"),
    sound: raw.sound !== false && raw.sound !== "false",
    minIntervalMs: Math.max(0, Number(raw.minIntervalMs) >= 0 ? Number(raw.minIntervalMs) : 8000),
    repeatAfterMs: Math.max(0, Number(raw.repeatAfterMs) >= 0 ? Number(raw.repeatAfterMs) : 20000),
  };
  if (process.platform !== "win32") {
    ok = false;
    lastError = "非 Windows 平台，不弹系统通知";
  } else if (!cfg.enabled || cfg.mode === "off") {
    ok = false;
    lastError = "notify.enabled=false";
  }
}

export function status() {
  const available = process.platform === "win32" && cfg.enabled && cfg.mode !== "off";
  return {
    enabled: !!cfg.enabled && cfg.mode !== "off",
    // 还没弹过（ok === null）时按平台/开关推断「应该可用」，别让设置页误报不可用
    ok: ok === false ? false : available,
    mode: cfg.mode,
    lastAt: lastAt ? new Date(lastAt).toISOString() : "",
    lastError: lastError || "",
  };
}

function strip(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function summaryOf(rec) {
  let cmd = "";
  if (rec.tool === "Bash") cmd = String((rec.cmd || rec.commands?.[0] || ""));
  else if (rec.cmd) cmd = String(rec.cmd);
  else {
    try { cmd = JSON.stringify(rec.input || {}); } catch { cmd = ""; }
  }
  return strip(cmd, 80);
}

function remainOf(rec) {
  const exp = Number(rec.expiresAt || 0);
  return exp ? Math.max(0, Math.ceil((exp - Date.now()) / 1000)) : 0;
}

function buildPayload(list, repeat = false) {
  // 首次入队时 approvals.json 可能还没落盘（scanLive 先 notify 再 write），
  // 所以只有 repeat 才用 isPending 过滤；首响按调用方给的记录直接弹。
  const live = repeat ? list.filter((r) => r && opts.isPending(r.id)) : list.filter(Boolean);
  if (!live.length) return null;
  const first = live[0];
  const n = live.length;
  const title = `LosFlow · AUTH ${n} 条等你批`;
  const s = subjectOf(first);
  const tool = first.tool || "工具";
  const cmd = summaryOf(first);
  const sec = remainOf(first);
  const head = s ? `#${first.taskId || "?"} ${s}` : `#${first.taskId || "?"}`;
  const line2 = [tool, cmd, sec ? (repeat ? `仍等你决定 · 剩 ${sec}s` : `剩 ${sec}s`) : ""].filter(Boolean).join(" · ");
  return { title, body: [head, line2].filter(Boolean).join("\n"), sound: cfg.sound };
}

function subjectOf(rec) {
  const s = String(rec.taskSubject || rec.task || "").trim();
  return strip(s, 24);
}

function send(payload) {
  if (!payload) return;
  if (spawning) return;
  if (!PATHS) return;
  const script = join(PATHS.agentDir, "win-notify.ps1");
  const ps = process.env.LOSFLOW_POWERSHELL || "powershell.exe";
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  spawning = true;
  // 节流从上一次「开始送」算，而不是等 PowerShell 的 6s 气球结束才算。
  lastAt = Date.now();
  let err = "";
  let child;
  try {
    child = spawn(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-PayloadB64", b64], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (e) {
    spawning = false;
    ok = false;
    lastError = String(e && e.message ? e.message : e);
    return;
  }
  child.stderr.on("data", (d) => {
    err += String(d || "");
  });
  child.on("error", (e) => {
    spawning = false;
    ok = false;
    lastError = String(e && e.message ? e.message : e).slice(0, 300);
  });
  child.on("close", (code) => {
    spawning = false;
    if (code === 0) {
      ok = true;
      lastError = "";
    } else {
      ok = false;
      lastError = (err || `win-notify.ps1 退出码 ${code}`).slice(0, 300);
      try { console.error("[notify] " + lastError); } catch { /* ignore */ }
    }
    if (spawning) {
      // 气球还在显示：pending 留着，等它关掉后的节流窗口再合并发送
      scheduleFlush(Math.max(0, cfg.minIntervalMs - (Date.now() - lastAt)));
    }
  });
}

function scheduleFlush(delay) {
  windowlessClearTimeout();
  flushTimer = setTimeout(flush, Math.max(0, delay));
  if (flushTimer.unref) flushTimer.unref();
}

function windowlessClearTimeout() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = 0;
}

function flush() {
  flushTimer = 0;
  if (spawning) {
    scheduleFlush(250);
    return;
  }
  const list = [...pending.values()];
  pending.clear();
  const payload = buildPayload(list);
  if (!payload) return;
  send(payload);
}

function enqueue(rec) {
  pending.set(rec.id, rec);
  const since = Date.now() - lastAt;
  if (lastAt && since < cfg.minIntervalMs) scheduleFlush(cfg.minIntervalMs - since);
  else flush();
}

function scheduleRepeat(rec) {
  if (!cfg.repeatAfterMs || repeats.has(rec.id)) return;
  const timer = setTimeout(() => {
    repeats.delete(rec.id);
    if (!opts.isPending(rec.id)) return;
    // 走同一个节流队列：28 连发的 repeat 会合并成一条，不会各响一次
    enqueue(rec);
  }, cfg.repeatAfterMs);
  if (timer.unref) timer.unref();
  repeats.set(rec.id, timer);
}

// 由 approvals.mjs 在新请求入队时调用。
export function notifyApproval(rec, { pendingCount = 1 } = {}) {
  if (!rec || !rec.id) return;
  if (!cfg.enabled || cfg.mode === "off" || process.platform !== "win32") return;
  if (seen.has(rec.id)) return;
  seen.add(rec.id);
  scheduleRepeat(rec);
  enqueue({ ...rec, _count: pendingCount });
}

// 已处理 / 过期时清掉 repeat 定时器（best effort；定时器里也会再查一次）。
export function forgetApproval(id) {
  const t = repeats.get(String(id));
  if (t) clearTimeout(t);
  repeats.delete(String(id));
  pending.delete(String(id));
}

export function stopNotify() {
  windowlessClearTimeout();
  for (const t of repeats.values()) clearTimeout(t);
  repeats.clear();
  pending.clear();
}
