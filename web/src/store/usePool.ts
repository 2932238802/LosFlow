import { computed, ref, watch } from "vue";
import { post } from "../api";
import type { PoolItem, WorkType } from "../types";
import { busy, refresh, s } from "./useAppState";
import { askConfirm } from "./useConfirm";
import { newProject } from "./useProjects";
import { focusNew } from "./useFocus";
import { flash } from "./useToast";
import { startProgress, stopProgress } from "./useProgress";
import { jobFor, loadJobs, watchJob, type Job } from "./useJobs";
import { parseSplit as parseSplitText, type SplitRow } from "../utils/split";
import { typeLabel } from "../utils/format";

export const newTitle = ref("");
export const newBody = ref("");
// 工作类型在入池时就定：开发 / 文档 / Plan（优化提示词也按它选 SKILL）
export const newWorkType = ref<WorkType>("dev");
export const pushing = ref<string | null>(null);
export const prio = ref("中");

export function setNewWorkType(v: WorkType) {
  newWorkType.value = v;
}

export function startPush(id: string) {
  pushing.value = id;
}
export function cancelPush() {
  pushing.value = null;
}
export function setPrio(p: string) {
  prio.value = p;
}
export function setNewTitle(v: string) {
  newTitle.value = v;
}
export function setNewBody(v: string) {
  newBody.value = v;
}
export function closeSplit() {
  splitItem.value = null;
}
export function setSplitPrompt(v: string) {
  splitPrompt.value = v;
}

export const poolOpen = computed(() => (s.value?.pool || []).filter((p) => p.stage !== "pushed"));
export const poolDone = computed(() => (s.value?.pool || []).filter((p) => p.stage === "pushed"));

// 拆分弹层
export const splitItem = ref<PoolItem | null>(null);
// 弹层里的「任务本身」工作副本：拆分基于这段正文；改过会先写回父条目，关掉也不丢
export const splitPrompt = ref("");
export type { SplitRow };
export const splitList = ref<SplitRow[]>([]);
// 容错解析的提示（第 N 条不合法等）；空 = 没问题
export const splitParseError = ref("");
// 本地的短动作（优化拆分提示词 / 加入池子）；「让 AI 拆」的忙碌状态由 job 驱动
const splitLocalBusy = ref(false);
let lastSplitFor = "";

export const splitJob = computed<Job | null>(() => (splitItem.value ? jobFor(splitItem.value.id) : null));
export const splitRunning = computed(() => splitJob.value?.status === "running");
export const splitBusy = computed(() => splitLocalBusy.value || splitRunning.value);

const countCache = new Map<string, number>();
export function splitCount(j: Job | null) {
  if (!j || j.status !== "ok") return 0;
  if (!countCache.has(j.id)) countCache.set(j.id, parseSplitText(j.result || "").rows.length);
  return countCache.get(j.id) || 0;
}

export async function openSplit(it: PoolItem) {
  const keep = lastSplitFor === it.id;
  lastSplitFor = it.id;
  splitItem.value = it;
  splitParseError.value = "";
  if (!keep) splitPrompt.value = it.note || "";

  let j = jobFor(it.id);
  if (!j) {
    await loadJobs();
    // 等待期间可能又点了别的池子条目：别把结果写到新弹层上
    if (splitItem.value?.id !== it.id) return;
    j = jobFor(it.id);
  }
  // 有结果就直接带出来（关掉弹层 / 刷新后都一样），不用再花一次钱
  if (j?.status === "ok" && (!keep || !splitList.value.length)) {
    const parsed = parseSplitText(j.result || "");
    splitList.value = parsed.rows.map((x) => ({ ...x, workType: it.workType || "dev" }));
    splitParseError.value = parsed.error;
  } else if (!keep) {
    splitList.value = [];
  }
  if (j?.status === "running") watchJob(j.id);
}

// job 终态驱动结果：不管弹层开着还是关掉，作业一完成就更新池子行能看到的记录。
// 弹层还开着时顺手填回列表并提示；关掉了就只留池子行的「有拆分结果 · 查看」。
watch(splitJob, (j, prev) => {
  if (!j || !prev || prev.status !== "running") return;
  if (j.status === "ok") {
    const parsed = parseSplitText(j.result || "");
    splitList.value = parsed.rows.map((x) => ({ ...x, workType: splitItem.value?.workType || "dev" }));
    splitParseError.value = parsed.error;
    if (parsed.error) flash(parsed.error, true);
    else flash(splitList.value.length ? "拆分完成" : "没解析出子任务，换句话再试", !splitList.value.length);
  } else if (j.status === "failed") {
    flash(`拆分失败：${j.error || "未知原因"}`, true);
  }
});

export async function aiSplit() {
  const it = splitItem.value;
  if (!it) return;
  const cur = jobFor(it.id);
  if (cur?.status === "running") {
    watchJob(cur.id);
    return flash("这条正在拆，等它跑完");
  }
  splitLocalBusy.value = true;
  try {
    // 弹层里改过的正文先落库：拆分基于它，关掉弹层也不丢
    const body = splitPrompt.value.trim();
    if (!body) return flash("先写任务本身，再让 AI 拆", true);
    if (body !== String(it.note || "").trim()) {
      const saved = await post("/api/pool/note", { id: it.id, note: body });
      it.note = saved.note;
    }
    const r = await post("/api/pool/suggest", { id: it.id });
    if (!r?.jobId) throw new Error("服务端没有返回作业号");
    flash(r.reused ? "这条已经在拆了，继续显示进度" : "已开始拆分 · 可以关掉弹层，结果会保留");
    watchJob(r.jobId);
  } catch (e: any) {
    flash(e.message, true);
  } finally {
    splitLocalBusy.value = false;
  }
}

export async function applySplit() {
  const it = splitItem.value;
  if (!it) return;
  const picked = splitList.value.filter((x) => x.on && x.title.trim());
  if (!picked.length) return flash("至少选一条", true);
  // 没有任务本身的子任务不能入池：在花钱/建条目前就拦住
  const empty = picked.findIndex((x) => !String(x.note || "").trim());
  if (empty >= 0) return flash(`第 ${empty + 1} 条还没写任务本身（note），补齐后再加入`, true);
  splitLocalBusy.value = true;
  try {
    const subs = picked.map((x) => ({
      title: x.title.trim(),
      owner: x.owner,
      reason: x.reason,
      note: String(x.note || "").trim(),
      workType: x.workType || it.workType || "dev",
    }));
    const r = await post("/api/pool/apply", { id: it.id, subs });
    flash(`已加入池子 ${r.created.length} 条（工作类型默认继承父条目）`);
    splitItem.value = null;
    refresh();
  } catch (e: any) {
    flash(e.message, true);
  }
  splitLocalBusy.value = false;
}

export async function optimizeDraft() {
  const text = newBody.value.trim() || newTitle.value.trim();
  if (!text) return flash("先写点内容再优化", true);
  busy.value = "draft";
  startProgress("正在优化提示词");
  flash("优化中…");
  try {
    const r = await post("/api/prompt/optimize", { text, workType: newWorkType.value });
    if (!r.prompt) throw new Error("没有拿到优化结果，稍后重试");
    newBody.value = r.prompt;
    flash(`已按「${typeLabel(newWorkType.value)}」优化，检查后加入池`);
  } catch (e: any) {
    flash(e.message, true);
  } finally {
    busy.value = "";
    stopProgress();
  }
}

export async function add() {
  const title = newTitle.value.trim();
  if (!title) return;
  try {
    await post("/api/pool/add", { title, note: newBody.value, project: newProject.value, workType: newWorkType.value });
    newTitle.value = "";
    newBody.value = "";
    flash("已加入任务池");
    refresh();
  } catch (e: any) {
    flash(e.message, true);
  }
}

export async function removePool(it: PoolItem) {
  const kids = (it.children || []).filter((cid) => (s.value?.pool || []).some((p) => p.id === cid && p.parent === it.id));
  const ok = await askConfirm({
    title: `删除池子条目？`,
    body: it.title,
    detail: kids.length
      ? `还有 ${kids.length} 条子任务：不会级联删除，删除后它们会保留并显示「父条目已删除」。`
      : "只从任务池移除，不碰任务表与终端历史。",
    okText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await post("/api/pool/remove", { id: it.id });
    // 只有新建框为空时才回填，避免覆盖正在写的新任务
    if (!newTitle.value.trim()) {
      newTitle.value = it.title || "";
      if (it.project) newProject.value = it.project;
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

// 工作类型：入池时定，池子里仍可改；推入建任务时写进任务行。
export async function setWorkType(it: PoolItem, workType: WorkType) {
  try {
    const r = await post("/api/pool/worktype", { id: it.id, workType });
    it.workType = r.workType;
    await refresh();
  } catch (e: any) {
    flash(e.message, true);
  }
}

export async function doPush() {
  const id = pushing.value!;
  const it = (s.value?.pool || []).find((x) => x.id === id);
  const kids = (it?.children || []).filter((cid) => (s.value?.pool || []).some((p) => p.id === cid && p.parent === id));
  // 父条目拆过：推入的是子任务，不会按父标题再建一条（D7）
  if (kids.length) {
    const ok = await askConfirm({
      title: `推入 ${kids.length} 条子任务？`,
      body: it?.title || id,
      detail: "推入拆出来的子任务（各自带任务本身），不会按父标题再建一条；已推过的子任务会跳过。推入后 Claude Code 任务会自动开工。",
      okText: `推入并开工 ${kids.length} 条`,
    });
    if (!ok) return;
  }
  busy.value = "push";
  try {
    const r = await post("/api/pool/push", { id, priority: prio.value });
    pushing.value = null;
    const n = (r.created || []).length;
    const docN = (r.docsync || []).length;
    const auto = r.autoStarted || [];
    const anyConnector = (s.value?.connectors || []).some((c) => c.enabled);
    flash(
      `已推入 ${n} 条${docN ? ` · 文档同步排队 ${docN} 条` : ""}` +
        (!anyConnector ? " · 没有启用的文档连接器，未入文档队列" : "") +
        (auto.length ? ` · 已自动开工 ${auto.map((x: string) => "#" + x).join(" ")}` : " · WorkBuddy 任务等 WB 取走")
    );
    refresh();
  } catch (e: any) {
    flash(e.message, true);
  }
  busy.value = "";
}

export function addManualLine() {
  splitList.value = [
    ...splitList.value,
    { title: "", owner: "claude-code", reason: "", note: "", on: true, workType: splitItem.value?.workType || "dev" },
  ];
}

// 「沿用父任务正文」：AI 拆分没给 note 时，一键把父条目写好的正文搬过来
export function useParentNote(i: number) {
  const parent = splitItem.value;
  const row = splitList.value[i];
  if (!parent || !row) return;
  if (!String(parent.note || "").trim()) return flash("父条目也没有正文，先在上面的输入框补一段", true);
  row.note = parent.note;
  if (!row.on) row.on = true;
}

// ---- 编辑正文（救存量：p9/p10 这类只有标题的空壳）----
export const editingNote = ref<string | null>(null);
export const noteDraft = ref("");

export function beginEditNote(it: PoolItem) {
  editingNote.value = it.id;
  noteDraft.value = it.note || "";
}
export function cancelEditNote() {
  editingNote.value = null;
  noteDraft.value = "";
}
export function setNoteDraft(v: string) {
  noteDraft.value = v;
}
export async function saveNote(it: PoolItem) {
  try {
    const r = await post("/api/pool/note", { id: it.id, note: noteDraft.value });
    it.note = r.note;
    editingNote.value = null;
    noteDraft.value = "";
    flash(r.note ? "正文已保存" : "正文已清空（推入/拆分前要补回来）");
    refresh();
  } catch (e: any) {
    flash(e.message, true);
  }
}

// 拆分前的「优化」：补全需求并写回父条目正文（不是改写一遍正文就丢，D9）
export async function optimizeSplitPrompt() {
  const it = splitItem.value;
  if (!it) return;
  splitLocalBusy.value = true;
  startProgress("正在补全拆分需求");
  try {
    const r = await post("/api/pool/optimize", { id: it.id });
    if (!r.note) throw new Error("没有拿到优化结果");
    splitPrompt.value = r.note;
    it.note = r.note;
    flash("已补全需求并写回父条目正文");
    refresh();
  } catch (e: any) {
    flash(e.message, true);
  } finally {
    splitLocalBusy.value = false;
    stopProgress();
  }
}
