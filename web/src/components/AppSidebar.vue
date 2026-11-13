<script setup lang="ts">
import { computed } from "vue";
import type { View } from "../types";
import { s } from "../store/useAppState";
import { poolOpen } from "../store/usePool";
import { doneTasks, openTasks } from "../store/useTasks";
import { pendingOf } from "../utils/approvals";
import { runningElapsed, runningId, termCount } from "../store/useTerminal";
import { setView, view } from "../store/useView";
import { wb } from "../store/useWb";

type NavItem = { key: View; label: string; badge: number | ""; live?: boolean };

// 一级入口；「已完成」不在这里，单独钉在栏底（价钱上方）。
const nav = computed<NavItem[]>(() => [
  { key: "tasks", label: "任务", badge: openTasks.value.length + poolOpen.value.length },
  { key: "terminals", label: "会话", badge: termCount.value, live: termCount.value > 0 },
  { key: "wb", label: "WorkBuddy", badge: wb.value.length || "" },
  { key: "settings", label: "设置", badge: "" },
]);

const doneBadge = computed(() => doneTasks.value.length);
// 其他页面也要知道「有人在等授权」：点一下跳到会话页（底部接管条 / 悬浮卡）
const authPending = computed(() => pendingOf(s.value));
const authIds = computed(() => [...new Set(authPending.value.map((a) => a.taskId).filter(Boolean).map((x) => "#" + x))]);
</script>

<template>
  <aside class="side">
    <div class="brand">LOSFLOW</div>
    <nav class="nav">
      <button v-for="item in nav" :key="item.key" :class="{ on: view === item.key }" @click="setView(item.key)">
        {{ item.label }} <b :class="{ live: item.live }">{{ item.badge }}</b>
      </button>
    </nav>
    <nav class="nav nav-foot">
      <button :class="{ on: view === 'done' }" @click="setView('done')">已完成 <b>{{ doneBadge }}</b></button>
    </nav>
    <div class="side-foot">
      <div v-if="authPending.length" class="live-line warn" @click="setView('terminals')">
        <span class="mini-dot on"></span>AUTH {{ authPending.length }} 条等你批<template v-if="authIds.length">（{{ authIds.join(" ") }}）</template>
      </div>
      <div v-if="runningId" class="live-line"><span class="mini-dot on"></span> CC 执行中 {{ runningElapsed }}s</div>
      <div class="cost">${{ Number(s?.spendToday || 0).toFixed(3) }}</div>
    </div>
  </aside>
</template>
