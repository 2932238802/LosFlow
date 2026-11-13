import { reactive, ref } from "vue";
import { post } from "../api";
import { busy, refresh } from "./useAppState";
import { flash } from "./useToast";

export const threshold = ref(5);
export const cronPrompt = ref("");

export function setThreshold(v: string | number) {
  threshold.value = Number(v) || 0;
}

export async function saveThreshold() {
  try {
    await post("/api/maintenance/config", { threshold: Number(threshold.value) || 0 });
    flash(Number(threshold.value) > 0 ? `每 ${threshold.value} 条自动整理` : "已关闭自动整理");
    refresh();
  } catch (e: any) {
    flash(e.message, true);
  }
}

export function buildCronPrompt() {
  cronPrompt.value = [
    "【每天的整理动作】",
    "1) 打开腾讯文档任务表：https://docs.qq.com/sheet/DZVFSeURwdmVJdVZL?tab=BB08J2",
    "2) 主表里任务状态为「已完成」或「已搁置」的行，移到「归档」tab（没有就建，并复制表头）",
    "3) 只动数据行，不动表头、序号公式、格式、筛选、隐藏列",
    "4) 移完读回核对：主表剩几行、归档有几行，用 report_task 回填结果",
    "5) 如果主表没有已完成的行，直接结束，不要建新行",
  ].join("\n");
}

export async function purge(hours: number) {
  busy.value = "purge";
  try {
    const r = await post("/api/maintenance/purge", { hours });
    flash(`已清 ${r.runs} 个 run、${r.wsl} 个 WSL 临时文件，剩 ${r.left.runs} 个`);
    refresh();
  } catch (e: any) {
    flash(e.message, true);
  }
  busy.value = "";
}

// 优化提示词 SKILL 模板（reactive 对象，模板里 v-model 字段可直接写）
export const tplOpen = ref(false);
export const tpl = reactive({ splitSystem: "", optimizeSystem: "" });

export function closeTpl() {
  tplOpen.value = false;
}

export async function openTpl() {
  try {
    const r = await post("/api/templates", {});
    Object.assign(tpl, r.templates || {});
    tplOpen.value = true;
  } catch (e: any) {
    flash(e.message, true);
  }
}

export async function saveTpl() {
  try {
    await post("/api/templates", tpl);
    tplOpen.value = false;
    flash("模板已保存");
  } catch (e: any) {
    flash(e.message, true);
  }
}
