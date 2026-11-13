<script setup lang="ts">
import type { Task } from "../types";
import {
  hist,
  isRunning,
  runningElapsed,
  selectTask,
  selectedTask,
  termTasks,
} from "../store/useTerminal";

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
      @click="selectTask(t.id)">
      <span class="sdot" :class="{ on: isRunning(t.id), err: t.run?.status && t.run.status !== 'ok' }"></span>
      <span class="sid">#{{ t.id }}</span>
      <span class="stitle">{{ t.subject }}</span>
      <span class="smeta" :class="badge(t).tone">{{ badge(t).text }}</span>
      <span v-if="t.run?.cost" class="scost">${{ Number(t.run.cost).toFixed(2) }}</span>
    </button>
  </div>
</template>
