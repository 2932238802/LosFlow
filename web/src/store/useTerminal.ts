import { computed, nextTick, reactive, ref, watch } from "vue";
import { post } from "../api";
import type { RawLine, Task, TermHistory, TermRound } from "../types";
import { nowMs, refresh, s } from "./useAppState";
import { askConfirm } from "./useConfirm";
import { flash } from "./useToast";
import { view } from "./useView";
import { anomalies, isChangedTool, roundMatches, roundStats } from "../utils/terminal";

// ---- 会话列表 / 选中 ----
export const termTasks = computed(() => {
  // 正在跑 / 刚投递的任务也要进来：它要等跑完才有 sessionId
  const list = (s.value?.tasks || []).filter(
    (x) => !x.docOnly && (x.sessionId || isRunning(x.id) || x.run || x.starting) && !termGone.value[x.id]
  );
  list.sort(
    (a, b) =>
      (isRunning(b.id) ? 1 : 0) - (isRunning(a.id) ? 1 : 0) ||
      (b.starting ? 1 : 0) - (a.starting ? 1 : 0) ||
      (b.updatedAt || 0) - (a.updatedAt || 0)
  );
  return list;
});

export const selected = ref<string | null>(null);
export const selectedTask = computed<Task | null>(() => {
  const list = termTasks.value;
  return list.find((t) => t.id === selected.value) || list[0] || null;
});
export function selectTask(id: string) {
  selected.value = String(id);
  ensureHistory(String(id));
}
export function goTerm(id: string) {
  view.value = "terminals";
  selectTask(id);
}

// 列表里没有选中项时自动选第一条（优先正在跑的）
watch(
  termTasks,
  (list) => {
    if (!list.length) return;
    if (!selected.value || !list.some((t) => t.id === selected.value)) selectTask(list[0].id);
  },
  { immediate: true }
);

export const termCount = computed(() => Number(s.value?.terminals?.count || 0));
export const runningId = computed(() => (s.value?.running && s.value.running.taskId) || null);

export function taskOf(id: string) {
  return (s.value?.tasks || []).find((t) => t.id === String(id)) || null;
}
// 这张卡自己的会话（并发派单时不会串台）；running.json 是「刚启动、台账还没写」的兜底
export function isRunning(id: string) {
  const t = taskOf(id);
  return !!t?.running || runningId.value === String(id);
}
export function startingOf(id: string) {
  return taskOf(id)?.starting || null;
}

export const runningElapsed = computed(() => {
  const st = s.value?.running?.startedAt;
  if (!st) return 0;
  const t0 = new Date(st.replace(" ", "T")).getTime();
  return Math.max(0, Math.round((nowMs.value - t0) / 1000));
});

// ---- 轮 / 动作（6 号契约）----
export const rounds = ref<Record<string, TermRound[]>>({});
export const hist = ref<Record<string, TermHistory>>({});
export const lastEventAt = ref<Record<string, number>>({});
const loading = new Set<string>();

function emptyHist(): TermHistory {
  return {
    source: "missing",
    running: false,
    truncated: false,
    hasMore: false,
    totalRounds: 0,
    stats: { rounds: 0, tools: 0, errors: 0, files: 0, filesChanged: [], turns: 0, durationMs: 0, cost: 0, lastEventAt: 0 },
    rounds: [],
    end: null,
  };
}

export async function loadRounds(id: string, before = 0) {
  const key = `${id}:${before}`;
  if (loading.has(key)) return;
  loading.add(key);
  try {
    const r = await fetch(`/api/task/raw?id=${encodeURIComponent(id)}&v=2${before ? `&before=${before}` : ""}`, { cache: "no-store" });
    const j = (await r.json()) as TermHistory & { error?: string };
    if (!j || j.error) return;
    const incoming = Array.isArray(j.rounds) ? j.rounds : [];
    if (before > 0) {
      const cur = rounds.value[id] || [];
      const seen = new Set(cur.map((x) => x.msgId));
      const older = incoming.filter((x) => !seen.has(x.msgId));
      rounds.value = { ...rounds.value, [id]: [...older, ...cur] };
      hist.value = { ...hist.value, [id]: { ...(hist.value[id] || emptyHist()), hasMore: !!j.hasMore } };
    } else {
      // 归档/流都不在时服务端返回空窗口；别把 SSE 已经推来的实时轮次擦掉
      if (!(j.source === "missing" && !incoming.length && (rounds.value[id] || []).length)) {
        rounds.value = { ...rounds.value, [id]: incoming };
      }
      hist.value = { ...hist.value, [id]: j };
      if (j.stats && j.stats.lastEventAt) {
        lastEventAt.value = { ...lastEventAt.value, [id]: j.stats.lastEventAt };
      }
    }
  } catch {
    /* 取不到就显示空态，不打断页面 */
  } finally {
    loading.delete(key);
  }
}

export function ensureHistory(id: string) {
  if (!hist.value[id]) loadRounds(id);
}

const fetchTimers: Record<string, number> = {};
function scheduleHistory(id: string, ms = 600) {
  window.clearTimeout(fetchTimers[id]);
  fetchTimers[id] = window.setTimeout(() => loadRounds(id), ms);
}

// ---- 增量：SSE 行 → 轮 / 动作 ----
export const raws = ref<Record<string, RawLine[]>>({});

function roundFor(id: string, msgId: string, at = ""): TermRound {
  const list = rounds.value[id] || (rounds.value[id] = []);
  let cur = list.find((r) => r.msgId === msgId);
  if (!cur) {
    cur = { i: (list.length ? list[list.length - 1].i : 0) + 1, msgId, at, status: "ok", think: "", say: "", actions: [] };
    list.push(cur);
  }
  return cur;
}

function applyLine(id: string, l: RawLine) {
  const list = rounds.value[id] || (rounds.value[id] = []);
  if (l.msgId) {
    const r = roundFor(id, l.msgId, l.at || "");
    if (l.kind === "think") r.think = [r.think, l.text].filter(Boolean).join("\n\n").slice(0, 4000);
    else if (l.kind === "say") r.say = [r.say, l.text].filter(Boolean).join("\n\n").slice(0, 2000);
    else if (l.kind === "cmd") {
      const aid = l.actionId || `live-${r.actions.length}`;
      if (!r.actions.some((a) => a.id === aid)) {
        r.actions.push({ id: aid, tool: l.tool || "", input: l.input || {}, ok: true, out: "", err: null, at: l.at || "" });
      }
    }
    return;
  }
  if ((l.kind === "out" || l.kind === "err") && l.actionId) {
    for (const r of list) {
      const a = r.actions.find((x) => x.id === l.actionId);
      if (!a) continue;
      a.ok = l.kind !== "err";
      a.out = l.text || a.out;
      if (!a.ok) { a.err = l.text || ""; r.status = "error"; }
      return;
    }
    return;
  }
  if (l.kind === "report") {
    const h = hist.value[id] || emptyHist();
    const end = h.end || { status: "ok", result: "" };
    hist.value = { ...hist.value, [id]: { ...h, end: { ...end, result: l.text || "" } } };
  }
}

// SSE /events/losflow 的入口：增量追加，不再整包替换
export function applyStream(e: any) {
  const id = String(e?.taskId || "");
  if (!id) return;
  if (e.kind === "run") {
    if (e.reset) {
      raws.value = { ...raws.value, [id]: [] };
      rounds.value = { ...rounds.value, [id]: [] };
      // 只给当前选中的会话补历史；其余会话等点开时再按需取
      if (selectedTask.value && selectedTask.value.id === id) scheduleHistory(id, 300);
    }
    return;
  }
  if (e.kind === "line" && e.line) {
    const cur = raws.value[id] || (raws.value[id] = []);
    cur.push(e.line as RawLine);
    if (cur.length > 3000) cur.splice(0, cur.length - 3000);
    lastEventAt.value = { ...lastEventAt.value, [id]: Date.now() };
    applyLine(id, e.line as RawLine);
    if (isFollowing(id)) followToBottom(id);
    else pendingNew.value = { ...pendingNew.value, [id]: (pendingNew.value[id] || 0) + 1 };
    return;
  }
  if (e.kind === "end") {
    // 结束：让服务端给一份最终结构（stats / end / 最终窗口）
    if (selectedTask.value && selectedTask.value.id === id) scheduleHistory(id, 800);
    refresh();
  }
}

// ---- 滚动跟随 ----
const termEls: Record<string, HTMLElement | null> = {};
export const termAtBottom = ref<Record<string, boolean>>({});
export const follow = ref<Record<string, boolean>>({});
export const pendingNew = ref<Record<string, number>>({});

export function isAtBottom(id: string) {
  return termAtBottom.value[id] === true;
}
export function isFollowing(id: string) {
  return follow.value[id] !== false;
}
function updateBottom(id: string) {
  const el = termEls[id];
  if (!el) return;
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  if (near !== isAtBottom(id)) termAtBottom.value = { ...termAtBottom.value, [id]: near };
  if (near !== isFollowing(id)) follow.value = { ...follow.value, [id]: near };
}
export function scrollBottom(id: string) {
  pendingNew.value = { ...pendingNew.value, [id]: 0 };
  nextTick(() => {
    const el = termEls[id];
    if (el) el.scrollTop = el.scrollHeight;
    updateBottom(id);
  });
}
export function onTermScroll(id: string) {
  updateBottom(id);
}
export function setTermEl(id: string, el: unknown) {
  termEls[id] = (el as HTMLElement) || null;
  if (termEls[id]) nextTick(() => updateBottom(id));
}
const scrollPending: Record<string, boolean> = {};
function followToBottom(id: string) {
  if (!isFollowing(id) || scrollPending[id]) return;
  scrollPending[id] = true;
  requestAnimationFrame(() => {
    scrollPending[id] = false;
    scrollBottom(id);
  });
}
export function toRound(id: string, roundIndex: number) {
  const el = document.getElementById(`round-${id}-${roundIndex}`);
  if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
}

// ---- 折叠 / 筛选 / 搜索 ----
export const roundFilter = ref<"all" | "changes" | "errors" | "commands">("all");
export const search = ref("");
const roundToggles = reactive<Record<string, Record<number, boolean>>>({});
const expandAllSet = reactive<Record<string, boolean>>({});

export function visibleRounds(id: string): TermRound[] {
  const list = rounds.value[id] || [];
  const q = search.value.trim();
  let out = list;
  if (roundFilter.value === "errors") out = out.filter((r) => r.status === "error" || r.actions.some((a) => !a.ok));
  else if (roundFilter.value === "changes") out = out.filter((r) => r.actions.some((a) => isChangedTool(a.tool, a.input)));
  else if (roundFilter.value === "commands") out = out.filter((r) => r.actions.length > 0);
  if (q) out = out.filter((r) => roundMatches(r, q));
  return out;
}

export function isRoundOpen(id: string, r: TermRound, isLast: boolean): boolean {
  if (search.value.trim()) return true;
  if (expandAllSet[id] === true) return true;
  if (expandAllSet[id] === false) return !!roundToggles[id]?.[r.i];
  const forced = roundToggles[id]?.[r.i];
  if (forced !== undefined) return forced;
  return isLast || r.status === "error";
}
export function toggleRound(id: string, i: number, fallback: boolean) {
  const cur = roundToggles[id] || (roundToggles[id] = {});
  cur[i] = !(cur[i] ?? fallback);
}
export function expandAll(id: string) {
  expandAllSet[id] = true;
  roundToggles[id] = {};
}
export function collapseAll(id: string) {
  expandAllSet[id] = false;
  roundToggles[id] = {};
}

export function statsOf(id: string) {
  return roundStats(rounds.value[id] || []);
}
export function anomaliesOf(id: string) {
  return anomalies(rounds.value[id] || [], {
    running: isRunning(id),
    lastEventAt: Math.max(lastEventAt.value[id] || 0, hist.value[id]?.stats?.lastEventAt || 0),
    now: nowMs.value,
  });
}

// ---- 全屏 ----
export const fullTerm = ref<string | null>(null);
export function toggleFull(id: string) {
  fullTerm.value = fullTerm.value === id ? null : id;
}
export function closeFull() {
  fullTerm.value = null;
}

// ---- 删除 / 复制 ----
export const termGone = ref<Record<string, boolean>>({});

export async function delRun(t: Task) {
  const runId = t.run?.id;
  if (!runId) {
    flash("这条没有可删的派单记录", true);
    return;
  }
  const ok = await askConfirm({
    title: `删除 #${t.id} 的这次会话？`,
    body: runId,
    detail:
      "会一起删：WSL /tmp 里的脚本/日志/流、data/streams 回放归档、tools/runs 归档、台账里这一行、任务上的会话指针（之后再跑是「新会话」）。\n台账这行删掉后，今天的花费统计也会少这一笔。",
    okText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await post("/api/run/delete", { id: runId, taskId: t.id });
    flash(`已删：WSL ${r.wslFiles} 个文件 · 归档 ${r.removedRun ? 1 : 0} · 台账 ${r.ledgerRemoved} 行 · 清掉 ${r.clearedTasks} 条会话指针`);
    termGone.value = { ...termGone.value, [t.id]: true };
    delete raws.value[t.id];
    delete rounds.value[t.id];
    delete hist.value[t.id];
    setTimeout(refresh, 300);
  } catch (e: any) {
    flash(e.message, true);
  }
}

export async function copyTerm(id: string) {
  const rs = rounds.value[id] || [];
  const text = rs.length
    ? rs
        .map((r) =>
          [r.think, r.say, ...r.actions.map((a) => [a.tool, JSON.stringify(a.input || {}), a.out].filter(Boolean).join(" "))].filter(Boolean).join("\n")
        )
        .join("\n\n")
    : (raws.value[id] || []).map((l) => l.text).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    flash(`已复制 #${id} 的 ${rs.length ? rs.length + " 轮" : (raws.value[id] || []).length + " 行"}`);
  } catch {
    flash("复制失败（浏览器不给剪贴板权限）", true);
  }
}

// 同一个任务重新开工时，把「已从终端删掉」的标记撤掉
watch(runningId, (id) => {
  if (id && termGone.value[id]) {
    const m = { ...termGone.value };
    delete m[id];
    termGone.value = m;
  }
});
