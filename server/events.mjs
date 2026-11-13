// events.mjs -- SSE 推送：Claude Code 的流式事件 + WorkBuddy 的 MCP 调用。
//
// Claude：tail WSL 里的 /tmp/cc-<id>.stream.jsonl（Windows 通过 \\wsl.localhost 读），
//          边跑边推；换文件时先发一条 reset。
// WorkBuddy：tail tools/wb-bridge/calls.jsonl。

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

let PATHS = null;
let DISTRO = "Ubuntu-26.04";

export function initEvents(paths) {
  PATHS = paths;
  DISTRO = paths.wslDistro || DISTRO;
}

const tmpDir = () => `\\\\wsl.localhost\\${DISTRO}\\tmp`;

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

function clock() {
  return new Date().toTimeString().slice(0, 8);
}

// ---- Claude stream ----
function newestStream() {
  try {
    const dir = tmpDir();
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir)
      .filter((f) => f.startsWith("cc-") && f.endsWith(".stream.jsonl"))
      .map((f) => join(dir, f));
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
  const file = `\\\\wsl.localhost\\${DISTRO}\\tmp\\cc-${dispatchId}.stream.jsonl`;
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const out = [];
    for (const l of lines) for (const e of streamLineToEvents(l)) out.push(e);
    return out.slice(-80);
  } catch {
    return [];
  }
}

function rawLine(o) {
  if (o.type === "assistant" && o.message?.content) {
    const out = [];
    for (const b of o.message.content) {
      if (b.type === "thinking" && (b.thinking || "").trim()) {
        // 思考过程：就是 claude 终端里那段灰字
        out.push({ kind: "think", text: b.thinking.trim().slice(0, 4000) });
      } else if (b.type === "text" && b.text?.trim()) out.push({ kind: "say", text: b.text.trim().slice(0, 600) });
      else if (b.type === "tool_use") {
        let inp = "";
        try { inp = JSON.stringify(b.input || {}); } catch { inp = ""; }
        out.push({ kind: "cmd", text: "$ " + b.name + " " + inp.slice(0, 400) });
      }
    }
    return out;
  }
  if (o.type === "user" && Array.isArray(o.message?.content)) {
    const out = [];
    for (const b of o.message.content) {
      if (b.type === "tool_result") {
        const txt = Array.isArray(b.content) ? b.content.map((x) => x.text || "").join(" ") : String(b.content ?? "");
        out.push({ kind: b.is_error ? "err" : "out", text: txt.slice(0, 800) });
      }
    }
    return out;
  }
  if (o.type === "result") {
    const out = [{ kind: "end", text: "--- 结束 " + (o.is_error ? o.subtype : "ok") + " · " + o.num_turns + " 轮 · $" + Number(o.total_cost_usd || 0).toFixed(3) }];
    // 最终回执全文：终端里最后那一整段结论，别截断
    const full = String(o.result || "").trim();
    if (full) out.push({ kind: "report", text: full.slice(0, 20000) });
    return out;
  }
  return [];
}

export function readRunRaw(dispatchId) {
  const file = `\\\\wsl.localhost\\${DISTRO}\\tmp\\cc-${dispatchId}.stream.jsonl`;
  if (!existsSync(file)) return [];
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
