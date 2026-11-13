// 拆分结果的容错解析（纯函数，可单测）。
//
// AI 返回的 JSON 常见三种坏法：
//   1. 包在 ```json 代码块里；
//   2. note 里有未转义的换行 / 制表符；
//   3. 某一条坏掉（多一个逗号、引号没转义），整批 JSON.parse 失败。
// 处理：先整体 parse；失败再逐个顶层对象 parse（可修复控制字符），坏一条不影响其余条目。

export type SplitRow = { title: string; owner: string; reason: string; note: string; on: boolean; workType?: "dev" | "docs" | "plan" };

function escapeControlChars(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === "\\" && inStr) {
      out += ch;
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (inStr && ch === "\n") {
      out += "\\n";
      continue;
    }
    if (inStr && ch === "\r") continue;
    if (inStr && ch === "\t") {
      out += "\\t";
      continue;
    }
    out += ch;
  }
  return out;
}

const asText = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : JSON.stringify(v));

function toRows(arr: any[]): SplitRow[] {
  return arr
    .filter((x) => x && typeof x === "object")
    .map((x: any) => ({
      title: asText(x.title).trim(),
      owner: x.owner === "workbuddy" ? "workbuddy" : "claude-code",
      reason: asText(x.reason),
      note: asText(x.note),
      on: true,
    }))
    .filter((x) => x.title);
}

export function parseSplit(raw: string): { rows: SplitRow[]; error: string } {
  const text = String(raw || "").replace(/```(?:json)?/gi, "").trim();
  const start = text.indexOf("[");
  if (start < 0) return { rows: [], error: "" };

  // 找到与第一个 [ 匹配的 ]（跳过字符串里的括号）
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\" && inStr) {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const segment = end >= 0 ? text.slice(start, end + 1) : text.slice(start);

  try {
    const arr = JSON.parse(segment);
    if (Array.isArray(arr)) return { rows: toRows(arr), error: "" };
  } catch {
    /* 逐条兜底 */
  }

  // 逐条扫描顶层 {...}
  const rows: SplitRow[] = [];
  const bad: number[] = [];
  let idx = 0;
  let i = segment.indexOf("{");
  while (i >= 0) {
    let d = 0;
    let str = false;
    let e = false;
    let j = i;
    let closed = -1;
    for (; j < segment.length; j += 1) {
      const ch = segment[j];
      if (e) {
        e = false;
        continue;
      }
      if (ch === "\\" && str) {
        e = true;
        continue;
      }
      if (ch === '"') {
        str = !str;
        continue;
      }
      if (str) continue;
      if (ch === "{") d += 1;
      else if (ch === "}") {
        d -= 1;
        if (d === 0) {
          closed = j;
          break;
        }
      }
    }
    if (closed < 0) break;
    idx += 1;
    const block = segment.slice(i, closed + 1);
    let obj: any = null;
    try {
      obj = JSON.parse(block);
    } catch {
      try {
        obj = JSON.parse(escapeControlChars(block));
      } catch {
        obj = null;
      }
    }
    if (obj && typeof obj === "object") {
      const mapped = toRows([obj]);
      if (mapped.length) rows.push(...mapped);
      else bad.push(idx);
    } else {
      bad.push(idx);
    }
    i = segment.indexOf("{", closed + 1);
  }
  const error = bad.length ? `第 ${bad.join("、")} 条不合法，其余 ${rows.length} 条已保留` : "";
  return { rows, error };
}
