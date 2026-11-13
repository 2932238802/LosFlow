// 终端渲染规则 / 摘要 / 异常提示：纯函数，不碰 DOM、不发请求。
// 6 号方案：后端给结构化「轮 + 动作」，这里负责「表达」——工具名 + 入参 → 中文动作。
import type { TermAction, TermEnd, TermRound, TermStats } from "../types";

export type ActionKind = "bash" | "read" | "write" | "edit" | "grep" | "glob" | "todo" | "web" | "task" | "other";

export type ActionView = {
  kind: ActionKind;
  icon: string;
  label: string;
  target: string;
  tail: string;
  changed: boolean;
  defaultOpen: boolean;
  /** 未知工具的原始入参，折叠展示 */
  detail: string;
};

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

export function baseName(p: string): string {
  const s = str(p).replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) || s : s;
}

export function lineCount(s: string): number {
  if (!s) return 0;
  return String(s).split("\n").length;
}

function diffStat(a: TermAction): { plus: number; minus: number } {
  const inp = a.input || {};
  if (a.tool === "MultiEdit" && Array.isArray(inp.edits)) {
    let plus = 0;
    let minus = 0;
    for (const e of inp.edits) {
      plus += lineCount(str(e && e.new_string));
      minus += lineCount(str(e && e.old_string));
    }
    return { plus, minus };
  }
  return { plus: lineCount(str(inp.new_string)), minus: lineCount(str(inp.old_string)) };
}

const READ_ONLY_BASH =
  /^(ls|cat|head|tail|less|grep|rg|find|pwd|echo|wc|sort|uniq|stat|file|which|env|git\s+(status|log|diff|show|branch)|npm\s+(run\s+)?(test|verify|typecheck|build)|node\s+--check|curl\s+-s\s+-o\s+\/dev\/null)\b/i;

function looksReadOnly(command: string): boolean {
  const first = String(command || "").trim().split(/\n|;|&&|\|\|/)[0].trim();
  if (!first) return true;
  if (/(^|\s)(>|>>|tee|sed\s+-i|chmod|chown|kill|pkill|mkdir|touch|rm|mv|cp)\b/.test(first)) return false;
  return READ_ONLY_BASH.test(first);
}

export function isChangedTool(tool: string, input?: Record<string, any>): boolean {
  if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(tool)) return true;
  if (tool === "Bash") return !looksReadOnly(str(input && input.command));
  return false;
}

function outLines(a: TermAction): number {
  return a.out ? a.out.split("\n").length : 0;
}

function hitsOf(out: string): number {
  const m = /Found\s+(\d+)\s+(?:files?|matches?)/i.exec(out || "");
  if (m) return Number(m[1]);
  return out ? out.split("\n").filter(Boolean).length : 0;
}

export function actionView(a: TermAction): ActionView {
  const inp = a.input || {};
  const tool = a.tool || "";
  const okTail = a.ok ? "" : "失败";
  const msTail = a.ms != null && a.ms > 0 ? `${a.ms}ms` : "";
  const tailWith = (...xs: string[]) => xs.filter(Boolean).join(" · ");

  switch (tool) {
    case "Bash": {
      const cmd = str(inp.command);
      return {
        kind: "bash",
        icon: "$",
        label: "$",
        target: cmd || "bash",
        tail: tailWith(okTail, msTail),
        changed: !looksReadOnly(cmd),
        defaultOpen: true,
        detail: "",
      };
    }
    case "Read":
      return {
        kind: "read",
        icon: "读",
        label: "读",
        target: baseName(str(inp.file_path)),
        tail: tailWith(outLines(a) ? `${outLines(a)} 行` : "", a.ok ? "" : "失败"),
        changed: false,
        defaultOpen: false,
        detail: "",
      };
    case "Write":
      return {
        kind: "write",
        icon: "写",
        label: "写",
        target: baseName(str(inp.file_path)),
        tail: tailWith(`+${lineCount(str(inp.content))} 行`, okTail),
        changed: true,
        defaultOpen: true,
        detail: "",
      };
    case "Edit":
    case "MultiEdit": {
      const d = diffStat(a);
      return {
        kind: "edit",
        icon: "改",
        label: "改",
        target: baseName(str(inp.file_path)),
        tail: tailWith(`+${d.plus} −${d.minus}`, okTail),
        changed: true,
        defaultOpen: true,
        detail: "",
      };
    }
    case "Grep":
      return {
        kind: "grep",
        icon: "搜",
        label: "搜",
        target: str(inp.pattern) || str(inp.query),
        tail: tailWith(a.ok ? `${hitsOf(a.out)} 命中` : "无命中", okTail),
        changed: false,
        defaultOpen: false,
        detail: "",
      };
    case "Glob":
      return {
        kind: "glob",
        icon: "找",
        label: "找",
        target: str(inp.pattern),
        tail: tailWith(a.ok ? `${hitsOf(a.out)} 文件` : "", okTail),
        changed: false,
        defaultOpen: false,
        detail: "",
      };
    case "TodoWrite": {
      const todos = Array.isArray(inp.todos) ? inp.todos : [];
      return {
        kind: "todo",
        icon: "待办",
        label: "待办",
        target: todos.length ? str(todos[0] && todos[0].content) : "",
        tail: `${todos.length} 项`,
        changed: false,
        defaultOpen: false,
        detail: "",
      };
    }
    case "WebFetch":
      return { kind: "web", icon: "网", label: "网", target: str(inp.url), tail: okTail, changed: false, defaultOpen: false, detail: "" };
    case "WebSearch":
      return { kind: "web", icon: "网", label: "网", target: str(inp.query), tail: okTail, changed: false, defaultOpen: false, detail: "" };
    case "Task":
    case "Agent":
      return {
        kind: "task",
        icon: "子任务",
        label: "子任务",
        target: str(inp.description) || str(inp.subagent_type),
        tail: okTail,
        changed: false,
        defaultOpen: false,
        detail: "",
      };
    default: {
      let json = "";
      try {
        json = JSON.stringify(inp || {});
      } catch {
        json = "";
      }
      return {
        kind: "other",
        icon: "⚙",
        label: tool ? `⚙ ${tool}` : "⚙",
        target: json.slice(0, 80),
        tail: okTail,
        changed: false,
        defaultOpen: false,
        detail: json,
      };
    }
  }
}

// 改动预览：Write 全为 +，Edit 先 − 后 +（最多 200 行，避免长文件把页面拖垮）
export function changePreview(a: TermAction): { sign: "+" | "-"; text: string }[] {
  const inp = a.input || {};
  const out: { sign: "+" | "-"; text: string }[] = [];
  const push = (sign: "+" | "-", s: unknown) => {
    for (const line of String(s || "").split("\n")) {
      if (out.length >= 200) return;
      out.push({ sign, text: line });
    }
  };
  if (a.tool === "Write") push("+", inp.content);
  else if (a.tool === "Edit") {
    push("-", inp.old_string);
    push("+", inp.new_string);
  } else if (a.tool === "MultiEdit" && Array.isArray(inp.edits)) {
    for (const e of inp.edits.slice(0, 20)) {
      push("-", e && e.old_string);
      push("+", e && e.new_string);
    }
  }
  return out;
}

// 搜索 / 复制的可匹配文本
export function actionText(a: TermAction): string {
  let input = "";
  try {
    input = JSON.stringify(a.input || {});
  } catch {
    input = "";
  }
  return [a.tool, input, a.out, a.err].filter(Boolean).join("\n");
}

export function roundText(r: TermRound): string {
  return [r.think, r.say, ...r.actions.map(actionText)].filter(Boolean).join("\n");
}

export function roundMatches(r: TermRound, q: string): boolean {
  if (!q) return true;
  return roundText(r).toLowerCase().includes(q.toLowerCase());
}

export function roundFiles(r: TermRound): string[] {
  const out = [];
  for (const a of r.actions) {
    if (!isChangedTool(a.tool, a.input)) continue;
    const p = a.input && (a.input.file_path || a.input.notebook_path || a.input.path);
    if (p) out.push(String(p));
  }
  return out;
}

export function roundStats(rounds: TermRound[]): { files: string[]; actions: number; errors: number } {
  const files = new Set<string>();
  let actions = 0;
  let errors = 0;
  for (const r of rounds) {
    for (const p of roundFiles(r)) files.add(p);
    for (const a of r.actions) {
      actions += 1;
      if (!a.ok) errors += 1;
    }
  }
  return { files: [...files], actions, errors };
}

export function statsText(
  stats: { files?: number | string[]; tools?: number; actions?: number; errors?: number } | null | undefined,
  rounds?: TermRound[]
): string {
  const st = stats || (rounds ? { files: roundStats(rounds).files.length, tools: roundStats(rounds).actions, errors: roundStats(rounds).errors } : null);
  if (!st) return "";
  const files = Array.isArray(st.files) ? st.files.length : Number(st.files) || 0;
  const tools = Number((st as any).tools ?? (st as any).actions) || 0;
  return `${files} 文件 · ${tools} 动作 · ${st.errors || 0} 错`;
}

// P2 摘要：改了 N 个文件（a、b…）· M 个动作 · K 个错误 · R 轮 · $x
export function summarize(rounds: TermRound[], end?: TermEnd): { text: string; files: string[]; actions: number; errors: number } {
  const s = roundStats(rounds);
  const names = s.files.map(baseName);
  const fileText = names.length
    ? `改了 ${names.length} 个文件（${names.slice(0, 3).join("、")}${names.length > 3 ? " 等" : ""}）`
    : "没改动文件";
  const cost = end && typeof end.cost === "number" ? ` · $${Number(end.cost).toFixed(3)}` : "";
  const turns = end && end.turns ? `${end.turns} 轮` : rounds.length ? `${rounds.length} 轮` : "";
  const text = [fileText, `${s.actions} 个动作`, `${s.errors} 个错误`, turns].filter(Boolean).join(" · ") + cost;
  return { text, files: s.files, actions: s.actions, errors: s.errors };
}

export type Anomaly = { kind: "stall" | "repeat" | "fail"; text: string; round: number };

// P2 异常：长时间无输出 / 重复命令 / 连续失败。只在真正满足阈值时返回。
export function anomalies(
  rounds: TermRound[],
  { running = false, lastEventAt = 0, now = Date.now() }: { running?: boolean; lastEventAt?: number; now?: number } = {}
): Anomaly[] {
  const out: Anomaly[] = [];

  if (running && lastEventAt > 0 && now - lastEventAt > 90_000) {
    out.push({ kind: "stall", text: `已 ${Math.round((now - lastEventAt) / 1000)} 秒没有新输出，可能在等授权 / 卡住`, round: 0 });
  }

  const seen = new Map<string, { n: number; round: number }>();
  for (const r of rounds) {
    for (const a of r.actions) {
      if (a.tool !== "Bash") continue;
      const cmd = str(a.input && a.input.command).replace(/\s+/g, " ").trim();
      if (!cmd) continue;
      const cur = seen.get(cmd) || { n: 0, round: r.i };
      cur.n += 1;
      seen.set(cmd, cur);
    }
  }
  for (const [cmd, v] of seen) {
    if (v.n >= 3) out.push({ kind: "repeat", text: `同一条命令重复了 ${v.n} 次（${cmd.slice(0, 60)}），可能在绕圈`, round: v.round });
  }

  let streak = 0;
  let firstRound = 0;
  for (const r of rounds) {
    for (const a of r.actions) {
      if (!a.ok) {
        if (streak === 0) firstRound = r.i;
        streak += 1;
        if (streak === 2) out.push({ kind: "fail", text: "连续 2 个动作失败", round: firstRound });
      } else {
        streak = 0;
      }
    }
  }
  return out;
}
