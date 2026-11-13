// 纯展示 / 文案函数，不碰状态。
import type { Approval, Area, EnvName, Task, WorkType } from "../types";

// 派单环境角标：WSL2 / Windows
type EnvModeLike = "wsl" | "windows" | "auto" | "" | undefined;
export function envLabel(e?: EnvName | EnvModeLike): string {
  return e === "windows" ? "Windows" : "WSL2";
}

// 回执缺金额时显示「—」，不要伪装成 $0.000
export function fmtUsd(v?: number | null): string {
  return v === null || v === undefined ? "—" : `$${Number(v).toFixed(3)}`;
}

export function pct(t: Task): number {
  if (t.status === "done") return 100;
  if (t.status === "doing") return 55;
  if (t.status === "blocked") return 30;
  // todo：先算「已落库」，异步文档同步回执后再推进一格（台账就绪，等开工）
  return t.docSync && t.docSync.status === "done" ? 30 : 10;
}

export function stageInfo(t: Task, running: boolean): { text: string; tone: string } {
  if (t.owner === "workbuddy") {
    if (t.wb?.reportedAt) return { text: `已回填 ${t.wb.reportStatus || ""} ${t.wb.reportedAt.slice(11, 16)}`, tone: "done" };
    if (t.wb?.takenAt) return { text: `WB 已取走 ${t.wb.takenAt.slice(11, 16)}`, tone: "live" };
    return { text: t.nudgedAt ? `等待 WB 取走 · 已催 ${t.nudges || 1} 次` : "等待 WB 取走", tone: "wait" };
  }
  // 已投递、子进程还没接管：立刻给反馈，别让界面静默等 600 秒
  if (t.starting) return { text: "执行中（启动中）", tone: "live" };
  if (running) return { text: "Claude 执行中", tone: "live" };
  if (t.status === "done") return { text: "已完成", tone: "done" };
  return { text: "待派单", tone: "wait" };
}

// 工作类型：入池时就定；旧数据的 review 按「文档」处理
export const WORK_TYPES: { value: WorkType; label: string }[] = [
  { value: "dev", label: "开发" },
  { value: "docs", label: "文档" },
  { value: "plan", label: "Plan" },
];

export function normWorkType(w?: string): WorkType {
  if (w === "review") return "docs";
  return w === "docs" || w === "plan" ? w : "dev";
}

export function typeLabel(w?: string): string {
  const map: Record<string, string> = { dev: "开发", docs: "文档", plan: "Plan", review: "文档" };
  return map[w || "dev"] || w || "";
}

export function areaLabel(a?: Area | null): string {
  return a?.kind === "docs" ? "文档区" : "代码区";
}

export function areaText(a?: Area | null): string {
  return a ? `${areaLabel(a)}${a.path ? " " + a.path : ""}` : "";
}

export function repoOf(t: Task): string {
  return (t.repo || "~/LosAngelous/Vesta").replace(/\/+$/, "");
}

export function docsDefault(t: Task): string {
  return repoOf(t) + "/docs";
}

export function joinPath(base: string, d: string): string {
  return (base.endsWith("/") ? base : base + "/") + d;
}

// 证据预填：最后一次回执的状态 + 轮次 + 花费（回执全文由 /api/task/run 按需补）
export function buildEvidence(t: Task): string {
  const r = t.run;
  if (!r) return "";
  return [r.status || "", r.turns ? `${r.turns} 轮` : "", typeof r.cost === "number" ? `$${Number(r.cost).toFixed(3)}` : ""]
    .filter(Boolean)
    .join(" · ");
}

export function docText(t: Task): string {
  const d = t.docSync;
  if (!d || !d.status) return "";
  if (d.status === "done") {
    const hhmm = d.doneAt ? new Date(d.doneAt).toTimeString().slice(0, 5) : "";
    return `文档已同步${hhmm ? " " + hhmm : ""}`;
  }
  const map: Record<string, string> = {
    pending: "文档同步排队中",
    running: "文档同步写入中",
    failed: `文档同步失败（试 ${d.attempts || 0} 次）`,
  };
  return map[d.status] || "";
}

export function fmtBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = Number(n) || 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function cmdText(a: Approval): string {
  const list = Array.isArray(a?.commands) ? a.commands : String(a?.cmd || "").split("\n").filter(Boolean);
  return list.join("  |  ") || "（没有命令原文）";
}

export function waitedFor(t: Task, nowMs: number): number {
  if (!t.updatedAt) return 0;
  return Math.max(0, Math.round((nowMs - t.updatedAt) / 60000));
}
