<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import AuthRail from "../components/AuthRail.vue";
import SessionList from "../components/SessionList.vue";
import TerminalCard from "../components/TerminalCard.vue";
import { s } from "../store/useAppState";
import {
  closeFull,
  fullTerm,
  isRoundOpen,
  search,
  selectTask,
  selectedTask,
  termCount,
  termTasks,
  toggleFull,
  toggleRound,
  visibleRounds,
} from "../store/useTerminal";
import { view } from "../store/useView";

const pending = computed(() => (s.value?.approvals || []).filter((a) => a.status === "pending"));
const searchEl = ref<HTMLInputElement | null>(null);

function onKey(e: KeyboardEvent) {
  if (view.value !== "terminals") return;
  const tag = (e.target as HTMLElement | null)?.tagName || "";
  const typing = tag === "INPUT" || tag === "TEXTAREA";

  if (e.key === "Escape") {
    if (fullTerm.value) {
      closeFull();
      return;
    }
    search.value = "";
    if (typing) (e.target as HTMLElement).blur();
    return;
  }
  if (typing) return;

  if (e.key === "/") {
    e.preventDefault();
    searchEl.value?.focus();
  } else if (e.key === "f" && selectedTask.value) {
    e.preventDefault();
    toggleFull(selectedTask.value.id);
  } else if (e.key === "j" || e.key === "k") {
    const list = termTasks.value;
    if (!list.length) return;
    const cur = Math.max(0, list.findIndex((t) => t.id === selectedTask.value?.id));
    const next = list[Math.min(list.length - 1, Math.max(0, cur + (e.key === "j" ? 1 : -1)))];
    if (next) selectTask(next.id);
  } else if (e.key === "Enter" && selectedTask.value) {
    const id = selectedTask.value.id;
    const rs = visibleRounds(id);
    const r = rs[rs.length - 1];
    if (r) toggleRound(id, r.i, isRoundOpen(id, r, true));
  }
}

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="term-head">
    <div>
      <div class="term-title">会话</div>
      <div class="term-sub">
        {{ termCount ? termCount + " 个会话正在跑" : "当前没有在跑" }} · 共 {{ termTasks.length }} 条 · 实时推送 · / 搜索 · j/k 切换 · f 全屏
      </div>
    </div>
    <span class="sp"></span>
    <input ref="searchEl" class="tsrch head-srch" :value="search" placeholder="搜索当前会话（/）" @input="search = ($event.target as HTMLInputElement).value" />
    <span v-if="termCount" class="pulse"><i></i>LIVE</span>
  </div>

  <div v-if="!s" class="skel"><i v-for="n in 3" :key="n"></i></div>
  <div v-else-if="!termTasks.length" class="term-empty">
    <div class="te-big">还没有会话</div>
    <div class="te-sub">在任务卡上点「执行」，这里就会出现它的实时输出：思考、命令、结果、回执全文。</div>
  </div>

  <div v-else class="term-grid" :class="{ 'with-rail': pending.length }">
    <aside class="sess-pane">
      <div class="sess-hd">会话 <b>{{ termTasks.length }}</b></div>
      <SessionList />
    </aside>

    <div class="detail-pane">
      <div v-if="fullTerm" class="term-backdrop" @click="closeFull"></div>
      <TerminalCard v-if="selectedTask" :key="selectedTask.id" :task="selectedTask" />
    </div>

    <AuthRail v-if="pending.length" />
  </div>
</template>
