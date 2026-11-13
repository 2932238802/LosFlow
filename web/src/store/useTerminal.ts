import { computed, nextTick, ref, watch } from "vue";
import { post } from "../api";
import type { RawLine, Task, TermHistory } from "../types";
import { nowMs, refresh, s } from "./useAppState";
import { askConfirm } from "./useConfirm";
import { flash } from "./useToast";
import { view } from "./useView";
import { buildLogRows, isChangedTool, logAnomalies, logStats, logText, rowMatches, type LogRow } from "../utils/terminal";

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
  expandSession(String(id));
}

// ---- 单个会话的展开 / 收起（点击会话行切换，状态跟随该会话并持久化） ----
const COLLAPSE_KEY = "losflow.term.collapsedSessions";
function readCollapsed(): Record<string, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}
export const collapsedSessions = ref<Record<string, boolean>>(readCollapsed());

function persistCollapsed() {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsedSessions.value));
  } catch {
    /* 隐私模式 */
  }
}

export function isSessionCollapsed(id: string): boolean {
  return !!collapsedSessions.value[String(id)];
}

export function expandSession(id: string) {
  const key = String(id);
  if (!collapsedSessions.value[key]) return;
  const next = { ...collapsedSessions.value };
  delete next[key];
  collapsedSessions.value = next;
  persistCollapsed();
}

export function toggleSession(id: string) {
  const key = String(id);
  const next = { ...collapsedSessions.value };
  if (next[key]) delete next[key];
  else next[key] = true;
  collapsedSessions.value = next;
  persistCollapsed();
  if (next[key] && fullTerm.value === key) closeFull();
}

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

// ---- 平铺日志（12 号方案）----
// 任何路径都只做「按 seq 合并、只追加」，不整体替换：SSE、HTTP 回填、
// 断线对账共用同一个 merge，避免把已经推来的实时行擦掉。
export const lines = ref<Record<string, RawLine[]>>({});
export const hist = ref<Record<string, TermHistory>>({});
export const lastEventAt = ref<Record<string, number>>({});
const loading = new Set<string>();
const fetchTimers: Record<string, number> = {};
// 换 run 时 epoch +1：之前发出去的整窗回填晚到，也不能把旧会话的行合并进来。
const epochs: Record<string, number> = {};

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

function lineKey(l: RawLine): string {
  if (l.seq !== undefined && l.seq !== null) return `s${l.seq}`;
  return `${l.at || ""}|${l.kind}|${l.text || ""}`;
}

export function mergeLines(existing: RawLine[], incoming: RawLine[], cap = 3000): RawLine[] {
  const map = new Map<string, RawLine>();
  for (const l of existing || []) if (l) map.set(lineKey(l), l);
  for (const l of incoming || []) if (l) map.set(lineKey(l), l);
  const out = [...map.values()].sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
  return out.length > cap ? out.slice(out.length - cap) : out;
}

export function lastSeq(id: string): number {
  const list = lines.value[id] || [];
  return list.length ? Number(list[list.length - 1].seq || 0) : 0;
}

export async function loadHistory(id: string, { after = 0, beforeSeq = 0 } = {}) {
  const epoch = epochs[id] || 0;
  const key = `${id}:${epoch}:${after}:${beforeSeq}`;
  if (loading.has(key)) return;
  loading.add(key);
  try {
    const qs = new URLSearchParams({ id, v: "2" });
    if (after) qs.set("after", String(after));
    if (beforeSeq) qs.set("beforeSeq", String(beforeSeq));
    const r = await fetch(`/api/task/raw?${qs.toString()}`, { cache: "no-store" });
    const j = (await r.json()) as TermHistory & { error?: string; hasEarlier?: boolean };
    if (!j || j.error) return;
    // 请求期间这条会话换了 run（SSE reset）：丢弃旧回填
    if ((epochs[id] || 0) !== epoch) return;
    const incoming = Array.isArray(j.lines) ? j.lines : [];
    if (beforeSeq > 0) {
      lines.value = { ...lines.value, [id]: mergeLines(incoming, lines.value[id] || []) };
      hist.value = { ...hist.value, [id]: { ...(hist.value[id] || emptyHist()), hasMore: !!j.hasEarlier } };
    } else {
      const cur = lines.value[id] || [];
      // 归档/流都不在时服务端返回空窗口；别把 SSE 已经推来的实时行擦掉
      if (!(j.source === "missing" && !incoming.length && cur.length)) {
        lines.value = { ...lines.value, [id]: mergeLines(cur, incoming) };
      }
      hist.value = {
        ...hist.value,
        [id]: { ...(hist.value[id] || emptyHist()), ...j, hasMore: !!j.hasEarlier },
      };
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
  if (!hist.value[id] || !(lines.value[id] || []).length) loadHistory(id);
}

// 断线 / 切回前台 / 服务重启后对账：整窗合并，多出来的行按 seq 去重。
export function reconcile(id?: string) {
  const tid = String(id || selectedTask.value?.id || "");
  if (tid) loadHistory(tid);
}

function scheduleHistory(id: string, ms = 600) {
  window.clearTimeout(fetchTimers[id]);
  fetchTimers[id] = window.setTimeout(() => loadHistory(id), ms);
}

// ---- SSE 入口 ----
export function applyStream(e: any) {
  const id = String(e?.taskId || "");
  if (!id) return;
  if (e.kind === "run") {
    if (e.reset) {
      epochs[id] = (epochs[id] || 0) + 1;
      lines.value = { ...lines.value, [id]: [] };
      hist.value = { ...hist.value, [id]: emptyHist() };
      // 只给当前选中的会话补历史；其余会话等点开时再按需取
      if (selectedTask.value && selectedTask.value.id === id) scheduleHistory(id, 300);
    }
    return;
  }
  if (e.kind === "line" && e.line) {
    const cur = lines.value[id] || [];
    lines.value = { ...lines.value, [id]: mergeLines(cur, [e.line as RawLine]) };
    lastEventAt.value = { ...lastEventAt.value, [id]: Date.now() };
    if (isFollowing(id)) followToBottom(id);
    else pendingNew.value = { ...pendingNew.value, [id]: (pendingNew.value[id] || 0) + 1 };
    return;
  }
  if (e.kind === "end") {
    if (selectedTask.value && selectedTask.value.id === id) scheduleHistory(id, 800);
    refresh();
  }
}

// ---- 日志行 / 筛选 ----
export const lineFilter = ref<"all" | "changes" | "errors" | "commands">("all");
export const search = ref("");

export function rowsOf(id: string): LogRow[] {
  return buildLogRows(lines.value[id] || []);
}

export function visibleRows(id: string): LogRow[] {
  const q = search.value.trim();
  let out = rowsOf(id);
  if (lineFilter.value === "errors") {
    out = out.filter((r) => r.kind === "err" || (r.kind === "cmd" && r.ok === false) || (r.kind === "end" && /error|失败/i.test(r.text)));
  } else if (lineFilter.value === "changes") {
    out = out.filter((r) => r.kind === "cmd" && isChangedTool(r.tool || "", r.input));
  } else if (lineFilter.value === "commands") {
    out = out.filter((r) => r.kind === "cmd");
  }
  if (q) out = out.filter((r) => rowMatches(r, q));
  return out;
}

export function statsOf(id: string) {
  const rows = rowsOf(id);
  const ls = logStats(rows);
  const base = hist.value[id]?.stats;
  return {
    actions: ls.actions,
    errors: ls.errors,
    files: ls.files,
    turns: base?.turns || 0,
    durationMs: base?.durationMs || 0,
    cost: base?.cost ?? null,
  };
}

export function anomaliesOf(id: string) {
  return logAnomalies(rowsOf(id), {
    running: isRunning(id),
    lastEventAt: Math.max(lastEventAt.value[id] || 0, hist.value[id]?.stats?.lastEventAt || 0),
    now: nowMs.value,
  });
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
      "会一起删：运行中的临时流（WSL /tmp 或 Windows data/runstate）、data/streams 回放归档、runs 归档、台账里这一行、任务上的会话指针（之后再跑是「新会话」）。\n台账这行删掉后，今天的花费统计也会少这一笔。",
    okText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await post("/api/run/delete", { id: runId, taskId: t.id });
    flash(
      `已删：${r.env === "windows" ? "Windows" : "WSL"} ${r.wslFiles || 0} 个文件 · 运行态 ${r.removedRunstate ? 1 : 0} · 归档 ${r.removedRun ? 1 : 0} · 台账 ${r.ledgerRemoved} 行 · 清掉 ${r.clearedTasks} 条会话指针`
    );
    termGone.value = { ...termGone.value, [t.id]: true };
    epochs[t.id] = (epochs[t.id] || 0) + 1;
    delete lines.value[t.id];
    delete hist.value[t.id];
    setTimeout(refresh, 300);
  } catch (e: any) {
    flash(e.message, true);
  }
}

export async function copyTerm(id: string) {
  const rows = rowsOf(id);
  const text = logText(rows);
  if (!text) return flash("这条会话还没有内容可复制", true);
  try {
    await navigator.clipboard.writeText(text);
    flash(`已复制 #${id} 的 ${rows.length} 行日志`);
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
