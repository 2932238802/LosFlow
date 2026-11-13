// 授权队列的纯函数：dock / float / 会话列表共用，避免三处各写一遍过滤。
import type { Approval, State, Task } from "../types";
import { cmdText } from "./format";

export function pendingOf(state: State | null | undefined, taskId?: string): Approval[] {
  const list = (state?.approvals || []).filter((a) => a.status === "pending");
  const scoped = taskId === undefined ? list : list.filter((a) => String(a.taskId || "") === String(taskId));
  return [...scoped].sort((a, b) => Number(a.atMs || 0) - Number(b.atMs || 0));
}

export function approvalForTask(state: State | null | undefined, taskId: string): Approval[] {
  return (state?.approvals || []).filter((a) => String(a.taskId || "") === String(taskId));
}

export function remainSeconds(a: Approval, now: number): number {
  if (!a.live || !a.expiresAt) return 0;
  return Math.max(0, Math.ceil((Number(a.expiresAt) - now) / 1000));
}

export function queueIndex(list: Approval[], id: string): number {
  return Math.max(0, list.findIndex((a) => a.id === id));
}

export function approvalTitle(a: Approval): string {
  if (a.live) return "Claude Code 请求执行";
  if (a.midRun) return "Claude Code 被拒绝了（本次运行还在继续）";
  return "Claude Code 想执行（运行已结束）";
}

export function approvalCtx(a: Approval): string {
  return [a.taskSubject || (a.taskId ? `#${a.taskId}` : ""), a.runId ? `run ${String(a.runId).slice(-6)}` : ""]
    .filter(Boolean)
    .join(" · ");
}

// 通知/悬浮卡用的短摘要：命令只取第一行，避免长命令撑爆卡片
export function approvalSummary(a: Approval, max = 140): string {
  const first = String(cmdText(a) || "").split("\n").find((x) => x.trim()) || "";
  return first.length > max ? first.slice(0, max) + "…" : first;
}

// 漏批后的「接着跑」判断：这次会话结束得不干净，或最近一次请求已过期/被拒。
export function needsResume(task: Task, approvals: Approval[]): boolean {
  if (task.run?.status === "running" || task.starting || task.running) return false;
  if (!task.sessionId) return false;
  if (task.run?.status && task.run.status !== "ok") return true;
  if (task.lastError) return true;
  return approvals.some((a) => String(a.taskId || "") === String(task.id) && (a.status === "expired" || a.status === "rejected"));
}
