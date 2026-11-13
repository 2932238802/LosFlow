<script setup lang="ts">
import type { Task } from "../types";
import { s } from "../store/useAppState";
import { pendingOf } from "../utils/approvals";
import {
  expandSession,
  hist,
  isRunning,
  isSessionCollapsed,
  runningElapsed,
  selectTask,
  selectedTask,
  termTasks,
  toggleSession,
} from "../store/useTerminal";

function authCount(id: string) {
  return pendingOf(s.value, id).length;
}

// 点击会话行：非当前会话 → 选中并展开；当前会话 → 切换展开 / 收起。
function onRow(t: Task) {
  if (selectedTask.value?.id === t.id) {
    toggleSession(t.id);
  } else {
    selectTask(t.id);
    expandSession(t.id);
  }
}

function badge(t: Task): { text: string; tone: string } {
  if (isRunning(t.id)) return { text: `${runningElapsed.value}s`, tone: "live" };
  if (t.starting) return { text: "启动中", tone: "live" };
  if (t.run?.status && t.run.status !== "ok") return { text: t.run.status, tone: "err" };
  const d = hist.value[t.id]?.stats?.durationMs;
  if (d) return { text: d >= 1000 ? `${Math.round(d / 1000)}s` : `${d}ms`, tone: "" };
  if (t.status === "done") return { text: "完成", tone: "done" };
  return { text: "待派单", tone: "" };
}
</script>

<template>
  <div class="sess-list">
    <div v-if="!termTasks.length" class="sess-empty">还没有会话</div>
    <button
      v-for="t in termTasks"
      :key="t.id"
      class="sess-item"
      :class="{ on: selectedTask?.id === t.id, live: isRunning(t.id) }"
      :title="selectedTask?.id === t.id ? (isSessionCollapsed(t.id) ? '点击展开这个会话' : '点击收起这个会话') : '点击打开这个会话'"
      @click="onRow(t)">
      <span class="sdot" :class="{ on: isRunning(t.id), err: t.run?.status && t.run.status !== 'ok' }"></span>
      <span class="sid">#{{ t.id }}</span>
      <span class="stitle">{{ t.subject }}</span>
      <span v-if="authCount(t.id)" class="smeta warn" :title="`${authCount(t.id)} 条授权等你批`">⚠ {{ authCount(t.id) }}</span>
      <span class="smeta" :class="badge(t).tone">{{ badge(t).text }}</span>
      <span v-if="t.run?.cost" class="scost">${{ Number(t.run.cost).toFixed(2) }}</span>
      <span class="scaret">{{ selectedTask?.id === t.id && !isSessionCollapsed(t.id) ? "▾" : "▸" }}</span>
    </button>
  </div>
</template>
