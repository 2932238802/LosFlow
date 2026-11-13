import { computed, ref } from "vue";
import { post } from "../api";
import type { ConfirmBits, PoolItem } from "../types";
import { busy, refresh, s } from "./useAppState";
import { askConfirm } from "./useConfirm";
import { newProject } from "./useProjects";
import { focusNew } from "./useFocus";
import { flash } from "./useToast";

export const newTitle = ref("");
export const newBody = ref("");
export const pushing = ref<string | null>(null);
export const prio = ref("中");

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
export const splitPrompt = ref("");
export const splitList = ref<{ title: string; owner: string; reason: string; on: boolean }[]>([]);
export const splitBusy = ref(false);

export async function optimizeDraft() {
  const text = newBody.value.trim() || newTitle.value.trim();
  if (!text) return flash("先写点内容再优化", true);
  busy.value = "draft";
  flash("优化中…");
  try {
    const r = await post("/api/prompt/optimize", { text });
    if (!r.prompt) throw new Error("没有拿到优化结果，稍后重试");
    newBody.value = r.prompt;
    flash("已优化，检查后加入池");
  } catch (e: any) {
    flash(e.message, true);
  }
  busy.value = "";
}

export async function add() {
  const title = newTitle.value.trim();
  if (!title) return;
  try {
    await post("/api/pool/add", { title, note: newBody.value, project: newProject.value });
    newTitle.value = "";
    newBody.value = "";
    flash("已加入任务池");
    refresh();
  } catch (e: any) {
    flash(e.message, true);
  }
}

export async function removePool(it: PoolItem) {
  const ok = await askConfirm({
    title: `删除池子条目？`,
    body: it.title,
    detail: "只从任务池移除，不碰任务表与终端历史。",
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

// 三项确认（细则 / 流程 / 授权）：推入时服务端读 confirm.auth 决定是否自动开工
export async function toggleConfirm(it: PoolItem, field: keyof ConfirmBits) {
  try {
    const r = await post("/api/pool/toggle", { id: it.id, field });
    it.confirm = r.confirm;
    await refresh();
  } catch (e: any) {
    flash(e.message, true);
  }
}

export async function doPush() {
  const id = pushing.value!;
  busy.value = "push";
  try {
    const r = await post("/api/pool/push", { id, priority: prio.value });
    pushing.value = null;
    const n = (r.created || []).length;
    const docN = (r.docsync || []).length;
    const auto = r.autoStarted || [];
    flash(
      `已推入 ${n} 条${docN ? ` · 文档同步排队 ${docN} 条` : ""}` +
        (auto.length ? ` · 已自动开工 ${auto.map((x: string) => "#" + x).join(" ")}` : " · 点「执行」即可开工")
    );
    refresh();
  } catch (e: any) {
    flash(e.message, true);
  }
  busy.value = "";
}

export function openSplit(it: PoolItem) {
  splitItem.value = it;
  splitPrompt.value = it.note || "";
  splitList.value = [];
}

export async function aiSplit() {
  const it = splitItem.value;
  if (!it) return;
  splitBusy.value = true;
  flash("让 Claude Code 拆…（约 15 秒，限 $0.35）");
  try {
    const r = await post("/api/pool/suggest", { id: it.id, prompt: splitPrompt.value });
    const m = (r.raw || "").match(/\[[\s\S]*\]/);
    const arr = m ? JSON.parse(m[0]) : [];
    splitList.value = arr.map((x: any) => ({
      title: String(x.title || ""),
      owner: x.owner === "workbuddy" ? "workbuddy" : "claude-code",
      reason: String(x.reason || ""),
      on: true,
    }));
    if (!splitList.value.length) flash("没解析出子任务，换句话再试", true);
  } catch (e: any) {
    flash(e.message, true);
  }
  splitBusy.value = false;
}

export async function applySplit() {
  const it = splitItem.value;
  if (!it) return;
  const picked = splitList.value.filter((x) => x.on && x.title.trim());
  if (!picked.length) return flash("至少选一条", true);
  splitBusy.value = true;
  try {
    const r = await post("/api/pool/apply", { id: it.id, subs: picked });
    flash(`已加入池子 ${r.created.length} 条`);
    splitItem.value = null;
    refresh();
  } catch (e: any) {
    flash(e.message, true);
  }
  splitBusy.value = false;
}

export function addManualLine() {
  splitList.value = [...splitList.value, { title: "", owner: "claude-code", reason: "", on: true }];
}

export async function optimizeSplitPrompt() {
  const text = splitPrompt.value.trim();
  if (!text) return flash("先写点需求", true);
  splitBusy.value = true;
  try {
    const r = await post("/api/prompt/optimize", { text });
    if (!r.prompt) throw new Error("没有拿到优化结果，稍后重试");
    splitPrompt.value = r.prompt;
    flash("已优化拆分提示词");
  } catch (e: any) {
    flash(e.message, true);
  }
  splitBusy.value = false;
}
