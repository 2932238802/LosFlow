<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Approval, Task } from "../types";
import { nowMs, s } from "../store/useAppState";
import { approve, reject, stopApprovalRun } from "../store/useTasks";
import { closeFull, expandSession, fullTerm, selectTask } from "../store/useTerminal";
import { cmdText } from "../utils/format";
import { approvalSummary, pendingOf, queueIndex, remainSeconds } from "../utils/approvals";

const props = defineProps<{ task: Task }>();
// 悬浮卡显示全部 pending：当前会话排最前，其他会话排在后面；单条处理完自动落到下一条。
const list = computed<Approval[]>(() => {
  const all = pendingOf(s.value);
  const cur = all.filter((a) => String(a.taskId || "") === String(props.task.id));
  const rest = all.filter((a) => String(a.taskId || "") !== String(props.task.id));
  return [...cur, ...rest];
});
const currentId = ref("");
const expanded = ref(false);
const minimized = ref(false);

const current = computed<Approval | null>(() => {
  if (!list.value.length) return null;
  return list.value.find((a) => a.id === currentId.value) || list.value[0];
});
const index = computed(() => (current.value ? queueIndex(list.value, current.value.id) : 0));
const summary = computed(() => (current.value ? approvalSummary(current.value, 180) : ""));
const fullCmd = computed(() => (current.value ? cmdText(current.value) : ""));
const remain = computed(() => (current.value ? remainSeconds(current.value, nowMs.value) : 0));
const isLive = computed(() => !!current.value?.live);
const isOther = computed(() => !!current.value && String(current.value.taskId || "") !== String(props.task.id));

// 队列变化：当前这条批完就自动落到下一条；新请求进来不抢正在看的那条。
watch(
  () => list.value.map((a) => a.id).join(","),
  () => {
    if (!list.value.length) {
      currentId.value = "";
      expanded.value = false;
      return;
    }
    if (!list.value.some((a) => a.id === currentId.value)) currentId.value = list.value[0].id;
  },
  { immediate: true }
);
watch(currentId, () => (expanded.value = false));

function move(step: number) {
  if (!list.value.length) return;
  const next = (index.value + step + list.value.length) % list.value.length;
  currentId.value = list.value[next].id;
}
function goto(a: Approval) {
  if (!a.taskId) return;
  if (fullTerm.value) closeFull();
  selectTask(String(a.taskId));
  expandSession(String(a.taskId));
  minimized.value = false;
}
function onKey(e: KeyboardEvent) {
  if (!list.value.length) return;
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    move(-1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    move(1);
  }
}

// Ctrl+Enter / Ctrl+Backspace 是全局快捷键：不需要先点一下卡片。
// 只有焦点在输入框 / 可编辑区域时不拦截，避免抢掉用户正在写的正文。
function onGlobalKey(e: KeyboardEvent) {
  if (!list.value.length || !current.value) return;
  if (e.defaultPrevented) return;
  const el = e.target as HTMLElement | null;
  const tag = el?.tagName || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
  if (e.ctrlKey && e.key === "Enter") {
    e.preventDefault();
    approve(current.value.id);
  } else if (e.ctrlKey && e.key === "Backspace") {
    e.preventDefault();
    reject(current.value.id);
  }
}

onMounted(() => window.addEventListener("keydown", onGlobalKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onGlobalKey));
</script>

<template>
  <button v-if="minimized && list.length" class="auth-pill" title="展开授权卡" @click="minimized = false">
    ⚠ AUTH {{ list.length }}
  </button>
  <section v-else-if="current" class="auth-dock" tabindex="0" @keydown="onKey">
    <div class="dock-line">
      <span class="pulse warn"><i></i>AUTH</span>
      <b class="dock-n">{{ index + 1 }}/{{ list.length }}</b>
      <span class="dock-ctx">
        #{{ current.taskId || task.id }}<template v-if="current.runId"> · run {{ String(current.runId).slice(-6) }}</template>
        <template v-if="isOther"> · 其他会话</template>
      </span>
      <span v-if="current.tool" class="dock-tool">{{ current.tool }}</span>
      <span class="dock-cmd" :class="{ open: expanded }" :title="expanded ? '收起命令' : '展开命令'" @click="expanded = !expanded">
        {{ summary }}
      </span>
      <button
        v-if="current.suggested?.length"
        class="iact dock-rule"
        title="批准并记住这条建议规则"
        @click.stop="approve(current.id, true)">
        {{ current.suggested[0] }}
      </button>
      <span class="sp"></span>
      <span v-if="isLive" class="dock-wait" :class="{ bad: remain <= 0 }">
        {{ remain > 0 ? `剩 ${remain}s` : "已超时，按拒绝继续" }}
      </span>
      <button v-if="isOther" class="iact" @click.stop="goto(current)">切过去</button>
      <template v-if="isLive">
        <button class="iact" @click.stop="approve(current.id)">只批这次</button>
        <button class="iact" @click.stop="approve(current.id, true)">批准并记住</button>
        <button class="iact danger" @click.stop="reject(current.id)">拒绝</button>
        <button class="iact" @click.stop="stopApprovalRun(current)">终止</button>
      </template>
      <template v-else-if="current.midRun">
        <button class="iact" @click.stop="approve(current.id, true)">批准并重派</button>
        <button class="iact danger" @click.stop="reject(current.id)">拒绝</button>
        <button class="iact" @click.stop="stopApprovalRun(current)">终止</button>
      </template>
      <template v-else>
        <button class="iact" @click.stop="approve(current.id)">批准</button>
        <button class="iact danger" @click.stop="reject(current.id)">拒绝</button>
      </template>
      <button v-if="list.length > 1" class="iact dock-nav" title="上一条（←）" @click.stop="move(-1)">←</button>
      <button v-if="list.length > 1" class="iact dock-nav" title="下一条（→）" @click.stop="move(1)">→</button>
      <button class="iact dock-min" title="收起悬浮卡（不处理请求）" @click.stop="minimized = true">–</button>
    </div>
    <pre v-if="expanded" class="dock-full">{{ fullCmd }}</pre>
    <div class="dock-foot">
      <span>建议放行 <code>{{ (current.suggested || []).join(" ") || "（无建议）" }}</code></span>
      <span class="sp"></span>
      <span>Ctrl+Enter 只批这次 · Ctrl+Backspace 拒绝（全局，不用先点卡片）</span>
    </div>
  </section>
</template>
