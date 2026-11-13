<script setup lang="ts">
import { s } from "../store/useAppState";
import { wb } from "../store/useWb";
</script>

<template>
  <div class="hd">WorkBuddy 调用 <b>{{ wb.length }}</b></div>
  <div class="log">
    <div v-if="!s" class="skel"><i v-for="n in 3" :key="n"></i></div>
    <div v-else-if="!wb.length" class="empty">— 还没有调用 —</div>
    <div v-for="(e, i) in wb" :key="i" class="line">
      <time>{{ (e.at || "").slice(11, 16) }}</time>
      <span>{{ e.ok ? "✓" : "✗" }} <b>{{ e.tool }}</b> <code>{{ e.args }}</code></span>
    </div>
  </div>
</template>
