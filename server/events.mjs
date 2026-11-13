// events.mjs -- SSE 推送：Claude Code 的流式事件 + WorkBuddy 的 MCP 调用。
//
// Claude：实时流按 runstate 解析（WSL -> \\wsl.localhost\<distro>\tmp，Windows -> data/runstate），
//          边跑边推；换文件时先发一条 reset。
// WorkBuddy：tail tools/wb-bridge/calls.jsonl。

import { readFileSync, existsSync, statSync, readdirSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

let PATHS = null;
let DISTRO = "Ubuntu-26.04";

export function initEvents(paths) {
  PATHS = paths;
  DISTRO = paths.wslDistro || DISTRO;
}

const wslTmpDir = () => `\\\\wsl.localhost\\${DISTRO}\\tmp`;
const runstateDir = () => PATHS.runstateDir || join(PATHS.dataDir, "runstate");
const wslStream = (runId) => join(wslTmpDir(), `cc-${runId}.stream.jsonl`);

function runStateOf(runId) {
  try {
    const file = join(runstateDir(), `${String(runId || "")}.json`);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function sseHead(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
}

function send(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// 其他模块（审批队列）往所有 /events/losflow 连接广播非终端事件
const losflowClients = new Set();
let denialSink = null;

export function broadcast(obj) {
  for (const res of losflowClients) {
    try {
      send(res, obj);
    } catch {
      losflowClients.delete(res);
    }
  }
}

export function setDenialSink(fn) {
  denialSink = typeof fn === "function" ? fn : null;
}

function clock() {
  return new Date().toTimeString().slice(0, 8);
}

// ---- Claude stream ----
// 旧接口 /events/claude 只看「最新的一条流」：WSL /tmp 和本地 runstate 里都找，按 mtime 取最新。
function newestStream() {
  try {
    const dirs = [wslTmpDir(), runstateDir()];
    const files = [];
    for (const dir of dirs) {
      try {
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir)) {
          if (f.startsWith("cc-") && f.endsWith(".stream.jsonl")) files.push(join(dir, f));
          else if (dir === runstateDir() && f.endsWith(".stream.jsonl")) files.push(join(dir, f));
        }
      } catch { /* 单个目录不可读不影响另一个 */ }
    }
    if (!files.length) return null;
    files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files[0];
  } catch {
    return null;
  }
}

export function streamLineToEvents(line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  const out = [];
  const at = clock();
  if (o.type === "system" && o.subtype === "init") {
    out.push({ kind: "init", at, text: `${o.model || ""} · ${(o.tools || []).length} tools` });
    return out;
  }
  if (o.type === "assistant" && o.message?.content) {
    for (const b of o.message.content) {
      if (b.type === "thinking" && (b.thinking || "").trim()) out.push({ kind: "think", at, text: b.thinking.trim().slice(0, 400) });
      else if (b.type === "text" && b.text?.trim()) out.push({ kind: "say", at, text: b.text.trim().slice(0, 400) });
      else if (b.type === "tool_use") {
        let input = "";
        try {
          input = JSON.stringify(b.input || {}).slice(0, 200);
        } catch {
          input = "";
        }
        out.push({ kind: "tool", at, name: b.name, input });
      }
    }
    return out;
  }
  if (o.type === "user" && Array.isArray(o.message?.content)) {
    for (const b of o.message.content) {
      if (b.type === "tool_result") {
        const txt = Array.isArray(b.content)
          ? b.content.map((x) => x.text || "").join(" ")
          : String(b.content ?? "");
        out.push({ kind: "result", at, text: txt.slice(0, 200), error: b.is_error ? "1" : "" });
      }
    }
    return out;
  }
  if (o.type === "result") {
    out.push({
      kind: "done",
      at,
      cost: o.total_cost_usd,
      turns: o.num_turns,
      error: o.is_error ? o.subtype || "error" : "",
      text: (o.result || "").slice(0, 160),
    });
    return out;
  }
  return out;
}

export function readRunEvents(dispatchId) {
  const { file } = resolveRunFile(dispatchId);
  if (!file) return [];
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const out = [];
    for (const l of lines) for (const e of streamLineToEvents(l)) out.push(e);
    return out.slice(-80);
  } catch {
    return [];
  }
}

function clockOf(ts) {
  if (!ts) return clock();
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? clock() : d.toTimeString().slice(0, 8);
}

function rawLine(o) {
  if (o.type === "assistant" && o.message?.content) {
    const out = [];
    const msgId = o.message.id || o.uuid || "";
    const at = clockOf(o.timestamp);
    for (const b of o.message.content) {
      if (b.type === "thinking" && (b.thinking || "").trim()) {
        // 思考过程：就是 claude 终端里那段灰字
        out.push({ kind: "think", text: b.thinking.trim().slice(0, 4000), msgId, at });
      } else if (b.type === "text" && b.text?.trim()) out.push({ kind: "say", text: b.text.trim().slice(0, 600), msgId, at });
      else if (b.type === "tool_use") {
        let inp = "";
        try { inp = JSON.stringify(b.input || {}); } catch { inp = ""; }
        out.push({
          kind: "cmd",
          text: "$ " + b.name + " " + inp.slice(0, 400),
          tool: b.name || "",
          input: b.input || {},
          actionId: b.id || "",
          msgId,
          at,
        });
      }
    }
    return out;
  }
  if (o.type === "user" && Array.isArray(o.message?.content)) {
    const out = [];
    const at = clockOf(o.timestamp);
    for (const b of o.message.content) {
      if (b.type === "tool_result") {
        const txt = Array.isArray(b.content) ? b.content.map((x) => x.text || "").join(" ") : String(b.content ?? "");
        out.push({
          kind: b.is_error ? "err" : "out",
          text: txt.slice(0, 4000),
          ok: !b.is_error,
          actionId: b.tool_use_id || "",
          at,
        });
      }
    }
    return out;
  }
  if (o.type === "result") {
    const out = [{ kind: "end", at: clock(), text: "--- 结束 " + (o.is_error ? o.subtype : "ok") + " · " + o.num_turns + " 轮 · " + fmtUsd(o.total_cost_usd) }];
    // 最终回执全文：终端里最后那一整段结论，别截断
    const full = String(o.result || "").trim();
    if (full) out.push({ kind: "report", text: full.slice(0, 20000) });
    return out;
  }
  return [];
}

export function readRunRaw(dispatchId) {
  const { file } = resolveRunFile(dispatchId);
  if (!file) return [];
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const out = [];
    for (const l of lines) {
      let o;
      try { o = JSON.parse(l); } catch { continue; }
      for (const x of rawLine(o)) out.push(x);
    }
    return out.slice(-300);
  } catch {
    return [];
  }
}

export function streamClaude(req, res) {
  sseHead(res);
  let file = null;
  let offset = 0;
  let closed = false;

  const tick = () => {
    if (closed) return;
    const newest = newestStream();
    if (!newest) return;
    if (newest !== file) {
      file = newest;
      offset = 0;
      send(res, { kind: "reset" });
      // 补发已有的尾部，避免连上时是空白
      try {
        const all = readFileSync(file, "utf8").split("\n").filter(Boolean);
        for (const line of all.slice(-40)) for (const e of streamLineToEvents(line)) send(res, e);
        offset = statSync(file).size;
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      const size = statSync(file).size;
      if (size <= offset) return;
      const buf = readFileSync(file);
      const chunk = buf.subarray(offset).toString("utf8");
      offset = size;
      for (const line of chunk.split("\n").filter(Boolean)) {
        for (const e of streamLineToEvents(line)) send(res, e);
      }
    } catch {
      /* ignore */
    }
  };

  const timer = setInterval(tick, 700);
  tick();
  req.on("close", () => {
    closed = true;
    clearInterval(timer);
    res.end();
  });
}

// ---- 多路复用终端流 ----
//
// 为什么不每张卡一条 SSE：浏览器同源 HTTP/1.1 并发连接上限 6 条，
// 已有 workbuddy（+ 可选 state），8 张终端卡各开一条会撞上限。
// 所以只有一条 /events/losflow，消息体里带 taskId。
const streamFile = (runId) => liveStreamPath(runId);

// ---- 轮 / 动作契约（6 号方案 P0）----
//
// 旧的 rawLine 把 stream-json 拍平成「行」，这里保留结构：
//   轮 = 一条 assistant 消息（message.id）+ 紧随其后的 tool_result
//   动作 = 一次 tool_use + 按 tool_use_id 配对的结果
//
// 读文件用流式 readline，不整包 readFileSync：实测单条流最大 11.7 MB。
const ROUND_WINDOW = 40;
const MAX_RESP = 2 * 1024 * 1024; // 单响应 2 MB 上限

// ---- 流文件解析（唯一入口）----
//
// 顺序：
//   1) data/streams/<id>.jsonl                     -> source=archive
//   2) runstate 里记的 stream（还在跑 / 刚跑完）    -> source=<env>
//   3) data/runstate/<id>.stream.jsonl（默认名）    -> source=windows
//   4) \\wsl.localhost\<distro>\tmp\cc-<id>.stream.jsonl -> source=wsl（旧数据兼容）
//   5) missing
export function resolveRunFile(runId) {
  const id = String(runId || "");
  const dir = PATHS.streamsDir || join(PATHS.dataDir, "streams");
  const archive = join(dir, `${id}.jsonl`);
  if (existsSync(archive)) return { file: archive, source: "archive" };

  const st = runStateOf(id);
  if (st && st.stream && existsSync(st.stream)) {
    return { file: st.stream, source: st.env === "windows" ? "windows" : "wsl" };
  }
  const local = join(runstateDir(), `${id}.stream.jsonl`);
  if (existsSync(local)) return { file: local, source: "windows" };

  const wsl = wslStream(id);
  if (existsSync(wsl)) return { file: wsl, source: "wsl" };
  return { file: "", source: "missing" };
}

// SSE 要在文件出现之前就开始 tail，所以这里返回「应该在哪」而不是「已经存在」。
export function liveStreamPath(runId) {
  const id = String(runId || "");
  const st = runStateOf(id);
  if (st && st.stream) return st.stream;
  const local = join(runstateDir(), `${id}.stream.jsonl`);
  if (existsSync(local)) return local;
  return wslStream(id);
}

const clip = (s, n) => String(s || "").slice(0, n);
const fmtUsd = (v) => (v === null || v === undefined ? "—" : `$${Number(v).toFixed(3)}`);
const safeJson = (v) => {
  try {
    return JSON.stringify(v || {});
  } catch {
    return "";
  }
};

function tsOf(ts) {
  const t = ts ? Date.parse(ts) : NaN;
  return Number.isNaN(t) ? 0 : t;
}
function clockOfTs(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toTimeString().slice(0, 8);
}

function linesFromRounds(rounds, end) {
  const out = [];
  for (const r of rounds) {
    if (r.think) out.push({ kind: "think", text: r.think });
    if (r.say) out.push({ kind: "say", text: r.say });
    for (const a of r.actions) {
      out.push({ kind: "cmd", text: `$ ${a.tool} ${safeJson(a.input).slice(0, 400)}` });
      if (a.out) out.push({ kind: a.ok ? "out" : "err", text: a.out });
    }
  }
  if (end) {
    out.push({
      kind: "end",
      text: `--- 结束 ${end.status === "ok" ? "ok" : end.status} · ${end.turns ?? "?"} 轮 · ${fmtUsd(end.cost)}`,
    });
    if (end.result) out.push({ kind: "report", text: end.result });
  }
  return out;
}

// 读一轮窗口；before=<round.i> 往前翻。stats 永远针对全会话。
// after / before（seq）用于平铺日志的增量对账：seq 由文件字节偏移派生，
// HTTP 回填与 SSE 增量用同一套编号，前端按 seq 合并去重。
export async function readRunRounds(runId, { before = 0, windowSize = ROUND_WINDOW, after = 0, beforeSeq = 0, includeLines = true } = {}) {
  const { file, source } = resolveRunFile(runId);
  if (!file) {
    return {
      dispatch: runId,
      source: "missing",
      running: false,
      truncated: false,
      hasMore: false,
      hasEarlier: false,
      firstSeq: 0,
      lastSeq: 0,
      totalRounds: 0,
      stats: { rounds: 0, tools: 0, errors: 0, files: 0, filesChanged: [], turns: 0, durationMs: 0, cost: 0, lastEventAt: 0 },
      rounds: [],
      end: null,
      lines: [],
    };
  }

  const rounds = [];
  const allLines = [];
  const wantLines = includeLines && windowSize > 0;
  const byAction = new Map();
  let end = null;
  let lastAt = 0;
  let lineStart = 0;

  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const raw of rl) {
    const start = lineStart;
    // readline 去掉行尾（LF / CRLF）；本项目 stream 文件按 LF 写。
    lineStart += Buffer.byteLength(raw, "utf8") + 1;
    // 极速跳过 system:thinking_tokens（实测占 11.7MB 文件里的 5.6 万行）
    if (!raw || (!raw.includes('"type":"assistant"') && !raw.includes('"type":"user"') && !raw.includes('"type":"result"'))) continue;
    let o;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    if (wantLines) {
      const produced = rawLine(o);
      for (let k = 0; k < produced.length; k += 1) {
        allLines.push({ ...produced[k], seq: start * 100 + k + 1 });
      }
    }
    if (o.type === "assistant" && Array.isArray(o.message?.content)) {
      const msgId = o.message.id || o.uuid || "";
      const at = clockOfTs(o.timestamp);
      const ts = tsOf(o.timestamp);
      if (ts) lastAt = Math.max(lastAt, ts);
      let cur = rounds.length ? rounds[rounds.length - 1] : null;
      if (!cur || cur.msgId !== msgId) {
        cur = { i: rounds.length + 1, msgId, at, ts, status: "ok", think: "", say: "", actions: [] };
        rounds.push(cur);
      }
      for (const b of o.message.content) {
        if (!b) continue;
        if (b.type === "thinking" && String(b.thinking || "").trim()) {
          cur.think = clip([cur.think, String(b.thinking).trim()].filter(Boolean).join("\n\n"), 4000);
        } else if (b.type === "text" && String(b.text || "").trim()) {
          cur.say = clip([cur.say, String(b.text).trim()].filter(Boolean).join("\n\n"), 2000);
        } else if (b.type === "tool_use") {
          const a = {
            id: b.id || `a${rounds.length}-${cur.actions.length}`,
            tool: b.name || "",
            input: b.input || {},
            ok: true,
            ms: null,
            out: "",
            err: null,
            at,
            ts,
          };
          cur.actions.push(a);
          byAction.set(a.id, { action: a, round: cur });
        }
      }
      continue;
    }
    if (o.type === "user" && Array.isArray(o.message?.content)) {
      const ts = tsOf(o.timestamp);
      if (ts) lastAt = Math.max(lastAt, ts);
      for (const b of o.message.content) {
        if (!b || b.type !== "tool_result") continue;
        const hit = byAction.get(b.tool_use_id || "");
        if (!hit) continue;
        const txt = Array.isArray(b.content) ? b.content.map((x) => x.text || "").join(" ") : String(b.content ?? "");
        const a = hit.action;
        a.ok = !b.is_error;
        a.out = clip(txt, 4000);
        a.err = b.is_error ? clip(txt, 2000) : null;
        if (ts && a.ts) a.ms = Math.max(0, ts - a.ts);
        if (!a.ok) hit.round.status = "error";
      }
      continue;
    }
    if (o.type === "result") {
      end = {
        status: o.is_error ? o.subtype || "error" : "ok",
        result: clip(o.result, 20000),
        durationMs: Number(o.duration_ms) || 0,
        turns: Number(o.num_turns) || 0,
        // 网关回执缺金额（null）时保持 null，前端显示「—」而不是假的 $0.000
        cost: o.total_cost_usd === null || o.total_cost_usd === undefined ? null : Number(o.total_cost_usd),
      };
    }
  }

  // ---- stats（针对全会话）----
  let actions = 0;
  let errors = 0;
  const changed = new Set();
  for (const r of rounds) {
    for (const a of r.actions) {
      actions += 1;
      if (!a.ok) errors += 1;
      if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(a.tool)) {
        const p = a.input && (a.input.file_path || a.input.notebook_path || a.input.path);
        if (p) changed.add(String(p));
      }
    }
  }
  const stats = {
    rounds: rounds.length,
    tools: actions,
    errors,
    files: changed.size,
    filesChanged: [...changed],
    turns: end ? end.turns : rounds.length,
    durationMs: end ? end.durationMs : 0,
    cost: end ? end.cost : 0,
    lastEventAt: lastAt,
  };

  // ---- 分页 ----
  const candidates = before > 0 ? rounds.filter((r) => r.i < before) : rounds;
  let win = windowSize > 0 ? candidates.slice(-windowSize) : [];
  let hasMore = candidates.length > win.length;

  // ---- 2 MB 上限：先压输出，再砍老轮 ----
  const payloadSize = () => Buffer.byteLength(JSON.stringify({ rounds: win, end }), "utf8");
  for (const limit of [1000, 200]) {
    if (payloadSize() <= MAX_RESP) break;
    for (const r of win) {
      r.think = clip(r.think, limit);
      for (const a of r.actions) a.out = clip(a.out, limit);
    }
  }
  while (payloadSize() > MAX_RESP && win.length > 1) {
    win = win.slice(1);
    hasMore = true;
  }

  // ---- 平铺日志窗口：after / before（seq）增量对账 ----
  let lineWin = allLines;
  if (after > 0) lineWin = lineWin.filter((l) => Number(l.seq) > after);
  if (beforeSeq > 0) lineWin = lineWin.filter((l) => Number(l.seq) < beforeSeq);
  let linesTruncated = false;
  while (lineWin.length > 1 && Buffer.byteLength(JSON.stringify(lineWin), "utf8") > MAX_RESP) {
    lineWin = lineWin.slice(1);
    linesTruncated = true;
  }
  const firstSeq = lineWin.length ? Number(lineWin[0].seq) : 0;
  const lastSeq = lineWin.length ? Number(lineWin[lineWin.length - 1].seq) : 0;
  const hasEarlier = !!firstSeq && allLines.length > 0 && Number(allLines[0].seq) < firstSeq;

  return {
    dispatch: runId,
    source,
    running: !end,
    truncated: hasMore || linesTruncated,
    hasMore,
    hasEarlier,
    firstSeq,
    lastSeq,
    totalRounds: rounds.length,
    stats,
    rounds: win,
    end,
    lines: wantLines ? lineWin : [],
  };
}

export async function readRunSummary(runId) {
  const r = await readRunRounds(runId, { windowSize: 0 });
  return r.source === "missing" ? null : r.stats;
}

function emitRaw(raw, taskId, cur, push, allowDenial = false, lineStart = 0) {
  let o;
  try {
    o = JSON.parse(raw);
  } catch {
    return;
  }
  const produced = rawLine(o);
  for (let k = 0; k < produced.length; k += 1) {
    const x = produced[k];
    // 记下 tool_use，后面权限拒绝时按 tool_use_id 找回命令原文
    if (x.kind === "cmd" && x.actionId) cur.actions.set(String(x.actionId), { tool: x.tool || "", input: x.input || null });
    // seq 与 HTTP 回填保持一致：文件字节偏移 * 100 + 该行内序号
    const seq = lineStart * 100 + k + 1;
    if (seq > cur.seq) cur.seq = seq;
    push({ kind: "line", taskId, seq, line: { ...x, seq } });
  }
  // 降级 C：运行中已经出现的 permission_decision=reject，立刻入队（不等到跑完）。
  // 只处理 live 的 run：回放已经结束的会话时不要把历史拒绝再报一遍。
  if (allowDenial && denialSink && o.type === "user" && Array.isArray(o.tool_result_meta)) {
    const texts = new Map();
    for (const b of o.message?.content || []) {
      if (b && b.type === "tool_result") {
        const t = Array.isArray(b.content) ? b.content.map((x) => x.text || "").join(" ") : String(b.content ?? "");
        texts.set(String(b.tool_use_id || ""), t);
      }
    }
    for (const m of o.tool_result_meta) {
      const dec = m && m.permission_decision;
      if (!dec || dec.decision !== "reject") continue;
      const uid = String(m.id || "");
      if (!uid || cur.denials.has(uid)) continue;
      cur.denials.add(uid);
      const a = cur.actions.get(uid) || {};
      try {
        denialSink({
          runId: cur.runId,
          taskId,
          toolUseId: uid,
          tool: a.tool || "",
          input: a.input || null,
          text: texts.get(uid) || "",
        });
      } catch {
        /* 入队失败不影响流 */
      }
    }
  }
  if (o.type === "result") {
    push({ kind: "end", taskId, status: o.is_error ? o.subtype || "error" : "ok" });
  }
}

export function streamLosflow(req, res, getTargets) {
  sseHead(res);
  losflowClients.add(res);
  let closed = false;
  let busy = false;
  const state = new Map(); // taskId -> { runId, offset, seq, actions, denials }
  const newCur = (runId) => ({ runId, offset: 0, seq: 0, actions: new Map(), denials: new Set() });

  const tick = async () => {
    if (closed || busy) return;
    busy = true;
    try {
      const targets = (await getTargets()) || [];
      const ids = new Set(targets.map((t) => String(t.taskId)));
      for (const id of [...state.keys()]) if (!ids.has(id)) state.delete(id);

      for (const t of targets) {
        const taskId = String(t.taskId);
        const runId = String(t.runId || "");
        if (!runId) continue;
        const file = streamFile(runId);
        let cur = state.get(taskId);

        if (!cur || cur.runId !== runId) {
          // 换了会话：先让前端清空这张卡，再补发尾部
          cur = newCur(runId);
          state.set(taskId, cur);
          send(res, { kind: "run", taskId, runId, reset: true });
          let buf = null;
          try {
            buf = readFileSync(file);
          } catch {
            buf = null;
          }
          if (buf && buf.length) {
            const nl = buf.lastIndexOf(10); // 只吃到最后一个完整行
            if (nl >= 0) {
              const complete = buf.subarray(0, nl).toString("utf8");
              const parts = complete.split("\n");
              // 只补发最后 300 行，但 seq 仍按文件真实偏移算，前端才能和 HTTP 回填对上
              let off = 0;
              const offsets = new Array(parts.length);
              for (let i = 0; i < parts.length; i += 1) {
                offsets[i] = off;
                off += Buffer.byteLength(parts[i], "utf8") + 1;
              }
              const from = Math.max(0, parts.length - 300);
              for (let i = from; i < parts.length; i += 1) {
                if (parts[i].trim()) emitRaw(parts[i], taskId, cur, (o) => send(res, o), !!t.live, offsets[i]);
              }
              cur.offset = nl + 1;
            }
          }
          continue;
        }

        // 增量：只消费完整的行，半行留到下一轮
        try {
          const size = statSync(file).size;
          if (size <= cur.offset) continue;
          const buf = readFileSync(file);
          const chunk = buf.subarray(cur.offset).toString("utf8");
          const nl = chunk.lastIndexOf("\n");
          if (nl < 0) continue;
          const complete = chunk.slice(0, nl);
          const parts = complete.split("\n");
          let off = cur.offset;
          for (const line of parts) {
            const start = off;
            off += Buffer.byteLength(line, "utf8") + 1;
            if (line.trim()) emitRaw(line, taskId, cur, (o) => send(res, o), !!t.live, start);
          }
          cur.offset += Buffer.byteLength(complete + "\n", "utf8");
        } catch {
          /* 文件还没建出来 */
        }
      }
    } catch {
      /* 一轮失败不影响连接 */
    }
    busy = false;
  };

  const timer = setInterval(tick, 700);
  tick();
  req.on("close", () => {
    closed = true;
    losflowClients.delete(res);
    clearInterval(timer);
    try { res.end(); } catch { /* already gone */ }
  });
}

// ---- WorkBuddy calls ----
export function streamWorkbuddy(req, res) {
  sseHead(res);
  const file = join(PATHS.dataDir, "calls.jsonl");
  let offset = 0;
  let closed = false;

  const emit = (line) => {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (o.kind !== "tool") return;
    send(res, {
      kind: "call",
      at: o.at || "",
      tool: o.tool,
      ok: !!o.ok,
      args: o.args ? JSON.stringify(o.args).slice(0, 120) : "",
    });
  };

  try {
    if (existsSync(file)) {
      const all = readFileSync(file, "utf8").split("\n").filter(Boolean);
      for (const line of all.slice(-12)) emit(line);
      offset = statSync(file).size;
    }
  } catch {
    /* ignore */
  }

  const timer = setInterval(() => {
    if (closed) return;
    try {
      if (!existsSync(file)) return;
      const size = statSync(file).size;
      if (size <= offset) return;
      const buf = readFileSync(file);
      const chunk = buf.subarray(offset).toString("utf8");
      offset = size;
      for (const line of chunk.split("\n").filter(Boolean)) emit(line);
    } catch {
      /* ignore */
    }
  }, 1000);

  req.on("close", () => {
    closed = true;
    clearInterval(timer);
    res.end();
  });
}
