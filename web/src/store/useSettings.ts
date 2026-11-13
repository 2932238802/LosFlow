import { reactive, ref } from "vue";
import { getJSON, post } from "../api";
import { busy, refresh } from "./useAppState";
import { flash } from "./useToast";

export const threshold = ref(5);
export const cronPrompt = ref("");

// ---- 派单环境配置（losflow.config.json 的非敏感字段）----
// 网关 key（windowsClaudeEnv）不经过这里：只在配置文件里手工维护。
export const cfg = reactive({
  defaultEnv: "wsl" as "wsl" | "windows",
  windowsClaudeCmd: "",
  claudeTimeoutSec: 600,
});
export const cfgEnvKeys = ref<string[]>([]);

export async function loadConfig() {
  try {
    const r = await getJSON("/api/config");
    cfg.defaultEnv = r.defaultEnv === "windows" ? "windows" : "wsl";
    cfg.windowsClaudeCmd = String(r.windowsClaudeCmd || "");
    cfg.claudeTimeoutSec = Number(r.claudeTimeoutSec) || 600;
    cfgEnvKeys.value = Array.isArray(r.windowsClaudeEnvKeys) ? r.windowsClaudeEnvKeys : [];
  } catch {
    /* 离线时保留默认值 */
  }
}

export async function saveConfig() {
  try {
    await post("/api/config", {
      defaultEnv: cfg.defaultEnv,
      windowsClaudeCmd: cfg.windowsClaudeCmd,
      claudeTimeoutSec: cfg.claudeTimeoutSec,
    });
    flash("派单环境配置已保存");
    refresh();
  } catch (e: any) {
    flash(e.message, true);
  }
}

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
    const rs = r.runstate ? `、${r.runstate} 个运行态` : "";
    flash(`已清 ${r.runs} 个 run、${r.wsl} 个 WSL 临时文件${rs}，剩 ${r.left.runs} 个`);
    refresh();
  } catch (e: any) {
    flash(e.message, true);
  }
  busy.value = "";
}

// ---- 提示词 SKILL（docs/skills/*.md）：文件化、可编辑、可 diff、可恢复默认 ----
export type SkillName = "split" | "optimize" | "optimize-dev" | "optimize-docs" | "optimize-plan" | "split-optimize";
export type SkillItem = { name: SkillName; path: string; content: string; output: string; fields: string[]; error: string };

export const SKILL_LABELS: Record<SkillName, string> = {
  split: "拆分",
  optimize: "优化提示词（通用）",
  "optimize-dev": "优化 · 开发",
  "optimize-docs": "优化 · 文档",
  "optimize-plan": "优化 · Plan",
  "split-optimize": "拆分前补全需求",
};

export const tplOpen = ref(false);
export const skillItems = ref<SkillItem[]>([]);
export const skillName = ref<SkillName>("split");
export const skillContent = ref("");
export const skillPreview = ref("");
export const skillErr = ref("");

export function currentSkill(): SkillItem | null {
  return skillItems.value.find((x) => x.name === skillName.value) || null;
}

function pickSkill(name: SkillName) {
  const s = skillItems.value.find((x) => x.name === name);
  skillContent.value = s?.content || "";
  skillErr.value = s?.error || "";
}

export function setSkillName(name: SkillName) {
  skillName.value = name;
  pickSkill(name);
}
export function setSkillContent(v: string) {
  skillContent.value = v;
}
export function closeTpl() {
  tplOpen.value = false;
}

export async function openTpl() {
  try {
    const r = await getJSON("/api/skills");
    skillItems.value = Array.isArray(r.skills) ? r.skills : [];
    skillPreview.value = r.preview || "";
    pickSkill(skillName.value);
    tplOpen.value = true;
  } catch (e: any) {
    flash(e.message, true);
  }
}

function absorbSkill(r: any) {
  if (r?.skill) {
    const idx = skillItems.value.findIndex((x) => x.name === r.skill.name);
    if (idx >= 0) skillItems.value.splice(idx, 1, r.skill);
    else skillItems.value.push(r.skill);
    skillErr.value = r.skill.error || "";
  }
  if (typeof r?.preview === "string") skillPreview.value = r.preview;
}

export async function saveTpl() {
  try {
    const r = await post("/api/skills", { name: skillName.value, content: skillContent.value });
    absorbSkill(r);
    flash("SKILL 已保存（下一次拆分/优化立即生效）");
  } catch (e: any) {
    skillErr.value = e.message;
    flash(e.message, true);
  }
}

export async function resetTpl() {
  try {
    const r = await post("/api/skills/reset", { name: skillName.value });
    absorbSkill(r);
    pickSkill(skillName.value);
    flash("已恢复内置默认");
  } catch (e: any) {
    flash(e.message, true);
  }
}
