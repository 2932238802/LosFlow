<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import { getJSON } from "../api";
import type { Task, TermAction } from "../types";
import { areaLabel, areaText, typeLabel } from "../utils/format";
import { actionView, changePreview } from "../utils/terminal";
import { openMark, reopen } from "../store/useMark";
import {
  anomaliesOf,
  collapseAll,
  copyTerm,
  delRun,
  expandAll,
  fullTerm,
  hist,
  isAtBottom,
  isRoundOpen,
  isRunning,
  loadRounds,
  onTermScroll,
  pendingNew,
  roundFilter,
  rounds,
  runningElapsed,
  scrollBottom,
  search,
  setTermEl,
  startingOf,
  statsOf,
  toggleFull,
  toggleRound,
  toRound,
  visibleRounds,
} from "../store/useTerminal";
import HighlightText from "./HighlightText.vue";

const props = defineProps<{ task: Task }>();
const id = computed(() => props.task.id);
const list = computed(() => visibleRounds(id.value));
const stats = computed(() => statsOf(id.value));
const fileCount = computed(() => stats.value.files.length);
const his = computed(() => hist.value[id.value]);
const warns = computed(() => anomaliesOf(id.value));
const fallbackResult = ref("");
const actOpen = reactive<Record<string, boolean>>({});

const FILTERS = [
  { key: "all", label: "全部" },
  { key: "changes", label: "只看改动" },
  { key: "errors", label: "只看错误" },
  { key: "commands", label: "只看命令" },
] as const;

function av(a: TermAction) {
  return actionView(a);
}
function preview(a: TermAction) {
  return changePreview(a);
}
function aOpen(a: TermAction) {
  if (search.value.trim()) return true;
  if (actOpen[a.id] !== undefined) return actOpen[a.id];
  return av(a).defaultOpen;
}
function toggleAct(a: TermAction) {
  actOpen[a.id] = !aOpen(a);
}
function roundFiles(r: any): number {
  const set = new Set<string>();
  for (const a of r.actions || []) {
    if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(a.tool)) {
      const p = a.input && (a.input.file_path || a.input.notebook_path || a.input.path);
      if (p) set.add(String(p));
    }
  }
  return set.size;
}
function isLastOf(r: any) {
  return list.value.length > 0 && list.value[list.value.length - 1].msgId === r.msgId;
}
// 最后一轮的 say 常常就是 end.result，别重复展示同一段
function showSay(r: any): boolean {
  if (!r.say) return false;
  const end = his.value?.end?.result || "";
  if (!end) return true;
  const a = String(r.say).trim();
  const b = String(end).trim();
  return !(a === b || (a.length > 40 && b.startsWith(a.slice(0, 40))));
}

// 流已不在时，至少把台账里的回执全文拿出来
watch(
  () => [his.value?.source, his.value?.rounds?.length, props.task.run?.id],
  async () => {
    fallbackResult.value = "";
    const h = his.value;
    if (!h || h.source !== "missing" || rounds.value[id.value]?.length) return;
    if (!props.task.run?.id) return;
    try {
      const j = await getJSON(`/api/task/run?id=${encodeURIComponent(id.value)}`);
      fallbackResult.value = String(j?.run?.result || "");
    } catch {
      /* ignore */
    }
  },
  { immediate: true }
);

onBeforeUnmount(() => setTermEl(id.value, null));

// 搜索 / 过滤变化后：跳到第一个命中，没有命中就回到顶部
watch([search, roundFilter], () => {
  nextTick(() => {
    const el = document.getElementById(`term-body-${id.value}`);
    if (!el) return;
    const mark = el.querySelector("mark.hl");
    if (mark) mark.scrollIntoView({ block: "center", behavior: "smooth" });
    else el.scrollTop = 0;
  });
});
</script>

<template>
  <div class="term" :class="{ live: isRunning(id), full: fullTerm === id }">
    <div class="term-hd">
      <span class="dot" :class="{ on: isRunning(id) }"></span>
      <b class="tid">#{{ task.id }}</b>
      <span class="tsub">{{ task.subject }}</span>
      <span class="sp"></span>
      <span v-if="isRunning(id)" class="badge live">{{ runningElapsed }}s</span>
      <span v-if="his?.end?.cost || task.run?.cost" class="tmeta">
        {{ his?.end?.status || task.run?.status || "" }} · ${{ Number(his?.end?.cost ?? task.run?.cost ?? 0).toFixed(2) }}
      </span>
      <span v-if="task.status === 'done'" class="done-badge" :title="areaText(task.area)">
        已完成<span v-if="task.workType"> · {{ typeLabel(task.workType) }} · {{ areaLabel(task.area) }}</span>
      </span>
      <button
        v-if="task.status !== 'done'"
        class="iact done"
        :disabled="isRunning(id)"
        title="跑完并核对后，点这里标注类型与区域，任务才真正算完成"
        @click.stop="openMark(task)">
        标记完成
      </button>
      <button v-else class="iact" @click.stop="reopen(task)">重新打开</button>
      <button class="iact" @click.stop="copyTerm(id)">复制</button>
      <button class="iact" @click.stop="toggleFull(id)">{{ fullTerm === id ? "还原" : "全屏" }}</button>
      <button class="iact danger" @click.stop="delRun(task)">删除</button>
    </div>

    <div class="term-meta">
      <span class="tstat" :class="{ bad: stats.errors > 0 }">
        {{ his?.totalRounds ? `${his.totalRounds} 轮 · ` : "" }}{{ fileCount }} 文件 · {{ stats.actions }} 动作 · {{ stats.errors }} 错
      </span>
      <span v-if="his?.source === 'missing' && !(rounds[id] || []).length" class="anom">原始流已不在（WSL /tmp 已清），只能看回执</span>
      <button v-for="(w, i) in warns" :key="i" class="anom" @click="toRound(id, w.round)">{{ w.text }}</button>
      <span class="sp"></span>
      <a class="iact" :href="`/api/task/stream?id=${encodeURIComponent(id)}`" download>原始日志</a>
    </div>

    <div class="term-tools">
      <span class="chips">
        <button v-for="f in FILTERS" :key="f.key" :class="{ on: roundFilter === f.key }" @click="roundFilter = f.key">{{ f.label }}</button>
      </span>
      <span class="sp"></span>
      <button class="iact" @click="expandAll(id)">展开全部</button>
      <button class="iact" @click="collapseAll(id)">收起全部</button>
      <button v-if="his?.hasMore" class="iact" @click="loadRounds(id, list[0]?.i || 0)">加载更早</button>
    </div>

    <div :id="`term-body-${id}`" :ref="(el) => setTermEl(id, el)" class="term-body" @scroll="onTermScroll(id)">
      <div v-if="!rounds[id]?.length" class="term-wait">
        <template v-if="his?.source === 'missing'">
          这次的流已不在（WSL /tmp 已清），只能看回执。<template v-if="fallbackResult"> 回执如下：</template>
        </template>
        <template v-else-if="startingOf(id)">已投递，等子进程接管…</template>
        <template v-else-if="isRunning(id)">会话已启动，等待第一条输出…</template>
        <template v-else>正在加载会话…</template>
      </div>

      <div v-for="r in list" :id="`round-${id}-${r.i}`" :key="r.msgId || r.i" class="round" :class="{ err: r.status === 'error' }">
        <div class="round-hd" @click="toggleRound(id, r.i, isRoundOpen(id, r, isLastOf(r)))">
          <span class="rnum">第 {{ r.i }} 轮</span>
          <span class="rmeta">{{ r.actions.length }} 动作<template v-if="roundFiles(r)"> · {{ roundFiles(r) }} 文件</template> · {{ r.at }}</span>
          <span class="sp"></span>
          <span v-if="r.status === 'error'" class="rerr">错误</span>
          <span class="rcaret">{{ isRoundOpen(id, r, isLastOf(r)) ? "▾" : "▸" }}</span>
        </div>
        <div v-if="isRoundOpen(id, r, isLastOf(r))" class="round-bd">
          <div v-if="r.think" class="r-think"><span class="rlabel">思考</span><HighlightText :text="r.think" :query="search" /></div>
          <div v-if="showSay(r)" class="r-say"><HighlightText :text="r.say" :query="search" /></div>

          <div v-for="a in r.actions" :key="a.id" class="act-row" :class="{ err: !a.ok }">
            <div class="act-hd" :class="{ clickable: a.out || preview(a).length || av(a).detail }" @click="toggleAct(a)">
              <span class="aicon" :class="'k-' + av(a).kind">{{ av(a).icon }}</span>
              <span class="alabel">{{ av(a).label }}</span>
              <span class="atarget"><HighlightText :text="av(a).target" :query="search" /></span>
              <span class="atail">{{ av(a).tail }}</span>
              <span class="sp"></span>
              <span v-if="a.out || preview(a).length || av(a).detail" class="acaret">{{ aOpen(a) ? "收起" : "展开" }}</span>
            </div>
            <pre v-if="aOpen(a) && a.out" class="aout" :class="{ err: !a.ok }"><HighlightText :text="a.out" :query="search" /></pre>
            <div v-if="aOpen(a) && preview(a).length" class="adiff">
              <div v-for="(l, i) in preview(a)" :key="i" :class="l.sign === '+' ? 'plus' : 'minus'">{{ l.sign }} {{ l.text }}</div>
            </div>
            <pre v-if="aOpen(a) && !a.out && av(a).kind === 'other' && av(a).detail" class="aout dim">{{ av(a).detail }}</pre>
          </div>
        </div>
      </div>

      <div v-if="his?.end" class="r-end">
        <div class="end-hd">
          结束 · {{ his.end.status }}<template v-if="his.end.turns"> · {{ his.end.turns }} 轮</template>
          <template v-if="his.end.cost"> · ${{ Number(his.end.cost).toFixed(3) }}</template>
        </div>
        <pre v-if="his.end.result" class="r-report"><HighlightText :text="his.end.result" :query="search" /></pre>
      </div>
      <pre v-else-if="fallbackResult" class="r-report">{{ fallbackResult }}</pre>
    </div>

    <button v-if="!isAtBottom(id)" class="jump" @click.stop="scrollBottom(id)">
      ↓ {{ pendingNew[id] ? pendingNew[id] + " 条新输出" : "底部" }}
    </button>
  </div>
</template>
