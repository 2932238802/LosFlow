<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";

defineProps<{ title: string }>();
const emit = defineEmits<{ (e: "close"): void }>();

// 弹层统一：ESC 关闭 + 背景不滚动，卸载时还原
let prevOverflow = "";

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    emit("close");
  }
}

onMounted(() => {
  prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  window.addEventListener("keydown", onKey);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  document.body.style.overflow = prevOverflow;
});
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="sheet">
      <h3>{{ title }}</h3>
      <slot />
      <div class="row2"><slot name="footer" /></div>
    </div>
  </div>
</template>
