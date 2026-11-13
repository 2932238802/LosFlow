<script setup lang="ts">
import { computed } from "vue";

// 搜索高亮：拆成片段渲染 <mark>，不用 v-html（避免把命令输出当 HTML 执行）
const props = defineProps<{ text: string; query?: string }>();

const parts = computed(() => {
  const src = String(props.text ?? "");
  const q = String(props.query || "").trim();
  if (!q) return [{ text: src, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  const lower = src.toLowerCase();
  const needle = q.toLowerCase();
  let i = 0;
  while (i < src.length) {
    const j = lower.indexOf(needle, i);
    if (j < 0) {
      out.push({ text: src.slice(i), hit: false });
      break;
    }
    if (j > i) out.push({ text: src.slice(i, j), hit: false });
    out.push({ text: src.slice(j, j + needle.length), hit: true });
    i = j + needle.length;
  }
  return out;
});
</script>

<template>
  <template v-for="(p, i) in parts" :key="i"><mark v-if="p.hit" class="hl">{{ p.text }}</mark><template v-else>{{ p.text }}</template></template>
</template>
