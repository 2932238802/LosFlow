import { ref } from "vue";

// 长动作（优化提示词 / 生成文档 / 拆分）的可见进度：没有真实百分比，
// 只告诉用户「还在跑、跑了多久」，避免顶部提示 3 秒后消失、看起来像没点。
export const progress = ref<{ label: string; since: number } | null>(null);

export function startProgress(label: string) {
  progress.value = { label, since: Date.now() };
}

export function stopProgress() {
  progress.value = null;
}
