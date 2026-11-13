import { reactive, ref } from "vue";
import { getJSON, post } from "../api";
import type { Task } from "../types";
import { buildEvidence, docsDefault, repoOf } from "../utils/format";
import { refresh } from "./useAppState";
import { askConfirm } from "./useConfirm";
import { flash } from "./useToast";

// 「标记完成」：类型 + 区域 + 证据（人验收后才推进任务状态）
export const WORK_TYPES = [
  { value: "dev", label: "开发" },
  { value: "review", label: "review" },
  { value: "plan", label: "Plan" },
];
export const markFor = ref<Task | null>(null);
export const markForm = reactive({ workType: "dev", areaKind: "code" as "code" | "docs", path: "", evidence: "" });
export const markDirs = ref<string[]>([]);
export const markParent = ref("");
export const markErr = ref("");
export const markBusy = ref(false);

export function closeMark() {
  markFor.value = null;
}

export async function browseDocs(path: string) {
  try {
    const j = await getJSON(`/api/wsl/ls?path=${encodeURIComponent(path)}`);
    markErr.value = j.error || "";
    markForm.path = j.path || path;
    markParent.value = j.parent || "";
    markDirs.value = j.dirs || [];
  } catch (e: any) {
    markErr.value = e.message;
  }
}

// 回执全文不在 /api/state 里（列表只带轻量字段），展开标记面板时按需取一次
async function fillEvidence(t: Task) {
  const base = String(t.evidence || "").trim() || buildEvidence(t);
  markForm.evidence = base;
  // 已经有证据（重新打开过的任务）就原样带出来，不重复拼回执
  if (String(t.evidence || "").trim() || !t.run?.id) return;
  try {
    const j = await getJSON(`/api/task/run?id=${encodeURIComponent(t.id)}`);
    const result = String(j?.run?.result || "").trim();
    const sm = j?.summary;
    // 规则摘要：改了 N 个文件 · N 个动作 · N 个错误 · N 轮（P2：证据不用人手翻终端）
    const summaryText = sm ? `改了 ${sm.files || 0} 个文件 · ${sm.tools || 0} 个动作 · ${sm.errors || 0} 个错误 · ${sm.turns || 0} 轮` : "";
    // 人已经动过证据就不覆盖
    if (markForm.evidence !== base) return;
    const head = [base, summaryText].filter(Boolean).join(" · ");
    const next = [head, result].filter(Boolean).join("\n").slice(0, 900);
    if (next) markForm.evidence = next;
  } catch {
    /* 取不到就只用轻量摘要 */
  }
}

export function openMark(t: Task) {
  markFor.value = t;
  const wt = t.workType && ["dev", "review", "plan"].includes(t.workType) ? t.workType : "dev";
  const kind: "code" | "docs" = t.area?.kind === "docs" ? "docs" : t.area?.kind === "code" ? "code" : wt === "dev" ? "code" : "docs";
  markForm.workType = wt;
  markForm.areaKind = kind;
  markForm.path = t.area?.path || (kind === "docs" ? docsDefault(t) : repoOf(t));
  markDirs.value = [];
  markParent.value = "";
  markErr.value = "";
  fillEvidence(t);
  if (kind === "docs") browseDocs(markForm.path);
}

export function pickWorkType(v: string) {
  markForm.workType = v;
  if (!markFor.value) return;
  // 开发默认代码区；review / Plan 默认文档区，路径给任务仓库下的 docs/
  if (v === "dev") {
    markForm.areaKind = "code";
    markForm.path = repoOf(markFor.value);
  } else {
    markForm.areaKind = "docs";
    if (!markForm.path || markForm.path === repoOf(markFor.value)) markForm.path = docsDefault(markFor.value);
    browseDocs(markForm.path);
  }
}

export function pickAreaKind(k: "code" | "docs") {
  markForm.areaKind = k;
  if (!markFor.value) return;
  if (k === "code") {
    markForm.path = repoOf(markFor.value);
  } else {
    if (!markForm.path || markForm.path === repoOf(markFor.value)) markForm.path = docsDefault(markFor.value);
    browseDocs(markForm.path);
  }
}

export async function submitMark() {
  const t = markFor.value;
  if (!t) return;
  const path = markForm.path.trim();
  if (markForm.areaKind === "docs" && !path) return flash("文档区要填路径", true);
  markBusy.value = true;
  markErr.value = "";
  try {
    await post("/api/task/status", {
      id: t.id,
      status: "done",
      workType: markForm.workType,
      area: { kind: markForm.areaKind, path: path || repoOf(t) },
      evidence: markForm.evidence.trim(),
    });
    markFor.value = null;
    flash(`#${t.id} 已标记完成，任务进入「已完成」`);
    await refresh();
  } catch (e: any) {
    markErr.value = e.message;
  }
  markBusy.value = false;
}

export async function reopen(t: Task) {
  const ok = await askConfirm({
    title: `重新打开 #${t.id}？`,
    body: t.subject,
    detail: "状态回到「待派单」，证据和上次回执保留。",
    okText: "重新打开",
  });
  if (!ok) return;
  try {
    await post("/api/task/status", { id: t.id, status: "todo" });
    flash(`#${t.id} 已重新打开`);
    refresh();
  } catch (e: any) {
    flash(e.message, true);
  }
}
