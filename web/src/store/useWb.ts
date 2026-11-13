import { ref } from "vue";
import type { WbCall } from "../types";

export const wb = ref<WbCall[]>([]);
let es: EventSource | null = null;

type WbEntry = { kind: string; at: string; tool: string; ok: boolean; args: string };

function key(e: { at?: string; tool?: string }) {
  return `${e.at || ""}|${e.tool || ""}`;
}

function normalize(c: WbCall): WbEntry {
  let args = "";
  if (typeof c.args === "string") args = c.args;
  else {
    try {
      args = JSON.stringify(c.args ?? {}).slice(0, 120);
    } catch {
      args = "";
    }
  }
  return { kind: "call", at: String(c.at || ""), tool: String(c.tool || ""), ok: !!c.ok, args };
}

// 刷新页面时用 /api/state 里已有的 calls 作为初始值，再合并 SSE 增量（按 at+tool 去重）
export function seedWb(list: WbCall[] | undefined) {
  const seen = new Set(wb.value.map(key));
  const merged = [...wb.value];
  for (const c of list || []) {
    const e = normalize(c);
    if (seen.has(key(e))) continue;
    seen.add(key(e));
    merged.push(e);
  }
  merged.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  wb.value = merged.slice(-40);
}

export function connectWb() {
  if (es || location.search.includes("static")) return;
  es = new EventSource("/events/workbuddy");
  es.onmessage = (m) => {
    let e: WbEntry;
    try {
      e = JSON.parse(m.data);
    } catch {
      return;
    }
    // SSE 重连会重发尾部 12 条：同一 at+tool 不重复记
    if (wb.value.some((x) => key(x) === key(e))) return;
    wb.value = [...wb.value, e].slice(-40);
  };
}

export function closeWb() {
  es?.close();
  es = null;
}
