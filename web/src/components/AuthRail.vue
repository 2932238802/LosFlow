<script setup lang="ts">
import { computed } from "vue";
import { cmdText } from "../utils/format";
import { nowMs, s } from "../store/useAppState";
import { approve, reject, stopApprovalRun } from "../store/useTasks";
import { pendingOf, remainSeconds } from "../utils/approvals";
import type { Approval } from "../types";

// history=true：设置页的「授权记录」；默认：仅当前 pending（兼容旧入口）
const props = defineProps<{ history?: boolean }>();
const list = computed<Approval[]>(() => (props.history ? s.value?.approvals || [] : pendingOf(s.value)));
const waitingLive = computed(() => list.value.some((a) => a.live && a.status === "pending"));

function remain(a: Approval) {
  return remainSeconds(a, nowMs.value);
}
function statusText(a: Approval) {
  if (a.status === "pending") return a.live ? "等待决定" : a.midRun ? "已拒绝 · 可重派" : "等待批准";
  if (a.status === "approved") return "已批准";
  if (a.status === "rejected") return "已拒绝";
  if (a.status === "expired") return "已超时";
  return a.status || "";
}
function title(a: Approval) {
  if (a.live) return "Claude Code 请求执行";
  if (a.midRun) return "Claude Code 被拒绝了（本次运行还在继续）";
  return "Claude Code 想执行（运行已结束）";
}
function ctx(a: Approval) {
  return [a.taskSubject || (a.taskId ? `#${a.taskId}` : ""), a.runId ? `run ${String(a.runId).slice(-6)}` : ""]
    .filter(Boolean)
    .join(" · ");
}
</script>

<template>
  <aside class="auth-rail" :class="{ history: props.history }">
    <div class="rail-hd">
      <span class="pulse warn"><i></i>{{ props.history ? "AUTH 记录" : "AUTH" }}</span>
      <b>{{ list.filter((a) => a.status === "pending").length }}</b><span class="tmeta">条待处理 · 共 {{ list.length }} 条</span>
    </div>
    <div v-if="!list.length" class="empty">— 还没有授权记录 —</div>
    <div v-for="a in list" :key="a.id" class="auth-card" :class="{ live: a.live && a.status === 'pending', midrun: a.midRun, resolved: a.status !== 'pending' }">
      <div class="ac-hd">
        {{ title(a) }}
        <span v-if="ctx(a)" class="ac-ctx">{{ ctx(a) }}</span>
        <span v-if="a.status !== 'pending'" class="ac-status" :class="a.status">{{ statusText(a) }}</span>
      </div>
      <div v-if="a.tool" class="ac-tool">{{ a.tool }}</div>
      <div class="ac-cmd">{{ cmdText(a) }}</div>
      <div v-if="a.suggested?.length" class="ac-rule">建议放行 <code>{{ (a.suggested || []).join(" ") }}</code></div>
      <div v-if="a.status === 'pending' && a.live" class="ac-wait">
        <span v-if="remain(a) > 0">请在 {{ remain(a) }}s 内决定 · 超时按拒绝继续</span>
        <span v-else>已超时：这次调用会按拒绝继续</span>
      </div>
      <div v-if="a.status === 'pending' && a.live" class="ac-acts">
        <button class="act" @click="approve(a.id)">只批这次</button>
        <button class="act" @click="approve(a.id, true)">批准并记住</button>
        <button class="act danger" @click="reject(a.id)">拒绝</button>
        <button class="act" @click="stopApprovalRun(a)">终止这次运行</button>
      </div>
      <div v-else-if="a.status === 'pending' && a.midRun" class="ac-acts">
        <button class="act" @click="approve(a.id, true)">批准并重派</button>
        <button class="act danger" @click="reject(a.id)">拒绝</button>
        <button class="act" @click="stopApprovalRun(a)">终止这次运行</button>
      </div>
      <div v-else-if="a.status === 'pending'" class="ac-acts">
        <button class="act" @click="approve(a.id)">批准</button>
        <button class="act danger" @click="reject(a.id)">拒绝</button>
      </div>
    </div>
    <div v-if="!props.history && waitingLive" class="rail-note">
      「只批这次」只放行当前这一步，同一次运行继续，不重派；「批准并记住」同时写进 allowlist。
    </div>
  </aside>
</template>
