import { computed, ref } from "vue";
import { getJSON, post } from "../api";
import type { Task } from "../types";
import { refresh, s } from "./useAppState";
import { askConfirm } from "./useConfirm";
import { flash } from "./useToast";

export const newProject = ref("");
export const projOpen = ref(false);
export const projName = ref("");
export const projPath = ref("~");
export const projDirs = ref<string[]>([]);
export const projParent = ref("");
export const projErr = ref("");
export const projPickOpen = ref(false);

export const currentProjectName = computed(() => {
  const list = s.value?.projects || [];
  const hit = list.find((x) => x.path === newProject.value);
  return hit ? hit.name : "选项目";
});

export function pickProject(path: string) {
  newProject.value = path;
  projPickOpen.value = false;
}
export function openPick() {
  projPickOpen.value = true;
}
export function closePick() {
  projPickOpen.value = false;
}
export function closeProj() {
  projOpen.value = false;
}
export function setProjName(v: string) {
  projName.value = v;
}

export async function openProj() {
  projOpen.value = true;
  projName.value = "";
  projErr.value = "";
  await browse("~");
}

export async function browse(path: string) {
  try {
    const j = await getJSON(`/api/wsl/ls?path=${encodeURIComponent(path)}`);
    if (j.error) projErr.value = j.error;
    projPath.value = j.path || path;
    projParent.value = j.parent || "";
    projDirs.value = j.dirs || [];
  } catch (e: any) {
    projErr.value = e.message;
  }
}

export async function saveProj() {
  const name = projName.value.trim();
  if (!name) return flash("给项目起个名字", true);
  try {
    await post("/api/projects/add", { name, path: projPath.value });
    projOpen.value = false;
    newProject.value = projPath.value;
    flash(`已添加项目 ${name}`);
    refresh();
  } catch (e: any) {
    flash(e.message, true);
  }
}

export async function delProj(id: string) {
  const pr = (s.value?.projects || []).find((x) => x.id === id);
  const ok = await askConfirm({
    title: "删除项目？",
    body: pr?.name || id,
    detail: "只从项目列表移除，不碰目录里的文件。",
    okText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await post("/api/projects/remove", { id });
    refresh();
  } catch (e: any) {
    flash(e.message, true);
  }
}

// ---- 任务卡「改目录」：复用同一套 WSL 目录浏览，不再用原生 prompt ----
export const repoOpen = ref(false);
export const repoFor = ref<Task | null>(null);
export const repoPath = ref("~");
export const repoDirs = ref<string[]>([]);
export const repoParent = ref("");
export const repoErr = ref("");

export function openRepo(t: Task) {
  repoFor.value = t;
  repoOpen.value = true;
  repoErr.value = "";
  browseRepo((t.repo || "~/LosAngelous/Vesta").trim() || "~");
}

export function closeRepo() {
  repoOpen.value = false;
  repoFor.value = null;
}

export async function browseRepo(path: string) {
  try {
    const j = await getJSON(`/api/wsl/ls?path=${encodeURIComponent(path)}`);
    repoErr.value = j.error || "";
    repoPath.value = j.path || path;
    repoParent.value = j.parent || "";
    repoDirs.value = j.dirs || [];
  } catch (e: any) {
    repoErr.value = e.message;
  }
}

export async function chooseRepo() {
  const t = repoFor.value;
  if (!t) return;
  try {
    await post("/api/task/repo", { id: t.id, repo: repoPath.value });
    const path = repoPath.value;
    closeRepo();
    flash(`#${t.id} 工作目录改为 ${path}`);
    refresh();
  } catch (e: any) {
    repoErr.value = e.message;
  }
}
