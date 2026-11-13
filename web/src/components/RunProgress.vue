<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { progress } from "../store/useProgress";

// 两种用法：
//   1) 不传 props：读全局 progress（优化提示词 / 生成文档等短动作）
//   2) 传 label + since：读某个后台 job（拆分），弹层里也能看到「跑了多久」
const props = withDefaults(
  defineProps<{ label?: string; since?: number; hint?: string }>(),
  { label: "", since: 0, hint: "" }
);

const shown = computed(() => {
  if (props.label) return { label: props.label, since: props.since || Date.now() };
  return progress.value;
});

const secs = ref(0);
let timer = 0;

function tick() {
  secs.value = shown.value ? Math.max(0, Math.round((Date.now() - shown.value.since) / 1000)) : 0;
}

onMounted(() => {
  tick();
  timer = window.setInterval(tick, 500);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <div v-if="shown" class="runprog" role="status" aria-live="polite">
    <div class="runprog-head">
      <span class="runprog-label">{{ shown.label }}</span>
      <span class="runprog-sec">{{ secs }}s</span>
    </div>
    <div class="runprog-track"><span class="runprog-fill"></span></div>
    <div class="runprog-hint">{{ hint || "完成后结果会直接填回输入框；失败会给出原因" }}</div>
  </div>
</template>
