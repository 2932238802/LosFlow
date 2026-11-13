import { computed, reactive, ref, watch } from "vue";
import { post } from "../api";
import type { Approval, Task, WorkType } from "../types";
import { busy, refresh, s } from "./useAppState";
import { askConfirm } from "./useConfirm";
import { focusNew } from "./useFocus";
import { openRepo } from "./useProjects";
import { newTitle } from "./usePool";
import { flash } from "./useToast";
import { startProgress, stopProgress } from "./useProgress";
import { isRunning } from "./useTerminal";
import { view } from "./useView";
import { typeLabel } from "../utils/format";

// 列表（docOnly = 纯文档同步活，不占任务页）
export const openTasks = computed(() => (s.value?.tasks || []).filter((t) => t.status !== "done" && !t.docOnly));
export const doneTasks = computed(() => (s.value?.tasks || []).filter((t) => t.status === "done" && !t.docOnly));

// 卡片展开 / 提示词草稿 / 优化记录
const OPEN_KEY = "losflow.open";
function readOpen(): string | null {
  try {
    return localStorage.getItem(OPEN_KEY);
  } catch {
    return null;
  }
}
export const open = ref<string | null>(readOpen());
export function toggleOpen(id: string) {
  open.value = open.value === id ? null : id;
}
watch(open, (v) => {
  try {
    if (v) localStorage.setItem(OPEN_KEY, v);
    else localStorage.removeItem(OPEN_KEY);
  } catch {
    /* 隐私模式 */
  }
});
export const drafts = reactive<Record<string, string>>({});
export const optInfo = ref<Record<string, any>>({});

const DRAFT_PREFIX = "losflow.draft.";
const draftTimers: Record<string, number> = {};

function readDraft(id: string): string | null {
  try {
    return localStorage.getItem(DRAFT_PREFIX + id);
  } catch {
    return null;
  }
}

export function draftOf(t: Task) {
  if (drafts[t.id] === undefined) drafts[t.id] = readDraft(t.id) ?? (t.note || t.subject);
  return drafts[t.id];
}

// 输入时写内存，300ms 后再落 localStorage（刷新不丢，又不每个键都写）
export function setDraft(id: string, v: string) {
  drafts[id] = v;
  window.clearTimeout(draftTimers[id]);
  draftTimers[id] = window.setTimeout(() => {
    try {
      localStorage.setItem(DRAFT_PREFIX + id, v);
    } catch {
      /* 隐私模式 */
    }
  }, 300);
}

export function clearDraft(id: string) {
  window.clearTimeout(draftTimers[id]);
  delete drafts[id];
  delete draftTimers[id];
  try {
    localStorage.removeItem(DRAFT_PREFIX + id);
  } catch {
    /* ignore */
  }
}

// 结果弹层
export const sheet = ref<{ title: string; body: string; json?: any } | null>(null);
export function closeSheet() {
  sheet.value = null;
}

// ---------- 任务动作 ----------
// 派单是「投递型」：接口 100ms 内返回，后台跑；前端先看到「启动中」，再 1s 快轮询接管结果。
let fastTimer = 0;
export function fastPoll(id: string) {
  window.clearInterval(fastTimer);
  const t0 = Date.now();
  fastTimer = window.setInterval(async () => {
    await refresh();
    const t = (s.value?.tasks || []).find((x) => x.id === String(id));
    const settled = isRunning(id) || (t && !t.starting && (t.sessionId || t.run));
    if (settled || Date.now() - t0 > 15000) {
      window.clearInterval(fastTimer);
      fastTimer = 0;
    }
  }, 1000);
}

export async function dispatchTask(t: Task, cont = false) {
  if (busy.value === t.id || t.starting) {
    flash("这条正在启动中，别连点（会重复花费）", true);
    return;
  }
  busy.value = t.id;
  try {
    const r = await post(cont ? "/api/task/continue" : "/api/task/dispatch", {
      id: t.id,
      task: drafts[t.id] || t.note || t.subject,
    });
    if (r?.newSession) flash(`环境已变，已新开${r.env === "windows" ? "Windows" : "WSL2"}会话（旧会话不能跨环境续接）`);
    else flash("已投递，正在接管…");
    await refresh(); // 立刻拿到 starting/running
    fastPoll(t.id);
  } catch (e: any) {
    flash(e.message, true);
  }
  busy.value = "";
}

// 漏批后的「接着跑」：复用续接链路（有 sessionId 走 /api/task/continue），
// 不重派新会话；确认一次，避免误点重复花钱。
export async function resumeTask(t: Task) {
  if (isRunning(t.id) || t.starting) {
    flash("这条还在跑，等它结束再说", true);
    return;
  }
  const ok = await askConfirm({
    title: `接着跑 #${t.id}？`,
    body: t.subject,
    detail: "会续接上一次会话，Claude 记得前面的上下文；会按原任务再产生一次派单花费。",
    okText: "接着跑",
  });
  if (!ok) return;
  await dispatchTask(t, true);
}

export async function stopRun(t: Task) {
  if (!isRunning(t.id)) {
    flash("这条不在跑（可能已经结束）", true);
    return;
  }
  const ok = await askConfirm({
    title: `终止 #${t.id}？`,
    body: t.subject,
    detail: "只杀这张卡自己的 Claude Code 会话；其他任务不受影响。已产生的花费不退。",
    okText: "终止",
    danger: true,
  });
  if (!ok) return;
  busy.value = "stop";
  try {
    const r = await post("/api/run/stop", { taskId: t.id });
    flash(r.note || "已终止");
  } catch (e: any) {
    flash(e.message, true);
  }
  busy.value = "";
  refresh();
}

export async function delTask(t: Task) {
  const ok = await askConfirm({
    title: `删除任务 #${t.id}？`,
    body: t.subject,
    detail: "任务从任务表移除；终端会话与台账保留，之后可在终端页单独删。",
    okText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await post("/api/task/delete", { id: t.id });
    clearDraft(t.id);
    // 只有新建框为空时才把文字放回去，别覆盖正在写的新任务
    if (!newTitle.value.trim()) {
      newTitle.value = t.subject || "";
      view.value = "tasks";
      focusNew();
      flash("已删除，文字放回新建框");
    } else {
      flash("已删除（新建框已有内容，没有覆盖）");
    }
    await refresh();
  } catch (e: any) {
    flash(e.message, true);
  }
}

export function setRepo(t: Task) {
  openRepo(t);
}

// 工作类型在入池时就定；taskboard 建的任务（或旧数据）可以在这里补/改。
// 改完「优化提示词」会按新类型选 SKILL，标记完成时也沿用它。
export async function setTaskWorkType(t: Task, workType: WorkType) {
  try {
    await post("/api/task/worktype", { id: t.id, workType });
    flash(`#${t.id} 工作类型改为 ${typeLabel(workType)}`);
    await refresh();
  } catch (e: any) {
    flash(e.message, true);
  }
}

export async function optimizePrompt(t: Task) {
  busy.value = t.id;
  const text = (drafts[t.id] ?? "").trim();
  if (!text) {
    busy.value = "";
    return flash("先写点东西再优化", true);
  }
  startProgress("正在优化提示词");
  flash("优化中…");
  try {
    const r = await post("/api/prompt/optimize", { text, taskId: t.id, workType: t.workType });
    if (!r.prompt) throw new Error("没有拿到优化结果，稍后重试");
    drafts[t.id] = r.prompt;
    optInfo.value = { ...optInfo.value, [t.id]: { cost: r.cost, at: new Date().toTimeString().slice(0, 5) } };
    flash("已优化，确认后再推送");
  } catch (e: any) {
    flash(e.message, true);
  } finally {
    busy.value = "";
    stopProgress();
  }
  refresh();
}

export async function genDocs(t: Task) {
  busy.value = t.id;
  startProgress("正在生成需求 / 交付 / 验收");
  flash("生成需求/交付/验收…");
  try {
    const r = await post("/api/task/docs", { id: t.id, title: t.subject, note: t.note || "" });
    const m = (r.raw || "").match(/\{[\s\S]*\}/);
    sheet.value = { title: `${t.subject} · 需求文档`, body: r.raw || "", json: m ? JSON.parse(m[0]) : null };
  } catch (e: any) {
    flash(e.message, true);
  } finally {
    busy.value = "";
    stopProgress();
  }
  refresh();
}

export async function splitTask(t: Task) {
  busy.value = t.id;
  startProgress("正在拆分任务");
  flash("智能拆分…");
  try {
    const r = await post("/api/task/split", { id: t.id, title: t.subject, note: t.note || "" });
    const m = (r.raw || "").match(/\[[\s\S]*\]/);
    sheet.value = { title: `${t.subject} · 拆分建议`, body: r.raw || "", json: m ? JSON.parse(m[0]) : null };
  } catch (e: any) {
    flash(e.message, true);
  } finally {
    busy.value = "";
    stopProgress();
  }
  refresh();
}

export async function nudge(t: Task) {
  try {
    const r = await post("/api/task/nudge", { id: t.id });
    sheet.value = { title: `催促 WorkBuddy · #${t.id}`, body: r.text };
    flash(`已生成催促文案（第 ${r.nudges} 次）`);
    refresh();
  } catch (e: any) {
    flash(e.message, true);
  }
}

export async function copySheet() {
  try {
    await navigator.clipboard.writeText(sheet.value?.body || "");
    flash("已复制，去 WorkBuddy 粘贴");
  } catch {
    flash("复制失败，手动选中吧", true);
  }
}

export async function cleanup() {
  try {
    const r = await post("/api/maintenance/cleanup", {});
    flash(`已入队文档同步 #${r.docsync?.id}（整理主表），等 WorkBuddy 取走`);
    refresh();
  } catch (e: any) {
    flash(e.message, true);
  }
}

export async function approve(id: string, remember = false) {
  try {
    const r = await post("/api/approve", { id, remember });
    if (r?.live) flash(remember ? "已放行并记住规则，同一次运行继续" : "已放行，同一次运行继续执行");
    else flash(r?.retry?.note || "已批准（按原任务重派一次）");
    refresh();
  } catch (e: any) {
    flash(e.message, true);
    refresh();
  }
}
export async function reject(id: string) {
  try {
    const r = await post("/api/reject", { id });
    flash(r?.live ? "已拒绝，同一次运行会收到拒绝理由继续" : "已拒绝");
    refresh();
  } catch (e: any) {
    flash(e.message, true);
    refresh();
  }
}

// live 卡片上的「终止这次运行」：按 taskId 走现有终止链路，只杀这张卡自己的会话。
export async function stopApprovalRun(a: Approval) {
  const taskId = String(a.taskId || "");
  if (!taskId) {
    flash("这条请求没有任务 id；去终端页按 runId 终止", true);
    return;
  }
  const ok = await askConfirm({
    title: `终止 #${taskId}？`,
    body: a.cmd ? a.cmd.slice(0, 200) : "这次会话会立即停止",
    detail: "只杀这张卡自己的 Claude Code 会话；已产生的花费不退。",
    okText: "终止",
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await post("/api/run/stop", { taskId });
    flash(r.note || "已终止");
  } catch (e: any) {
    flash(e.message, true);
  }
  refresh();
}

