<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import { getJSON } from "../api";
import type { LogRow } from "../utils/terminal";
import type { Task } from "../types";
import { areaLabel, areaText, envLabel, fmtUsd, typeLabel } from "../utils/format";
import { actionView, changePreview, rowAction } from "../utils/terminal";
import { approvalForTask, needsResume, pendingOf, remainSeconds } from "../utils/approvals";
import { nowMs, s } from "../store/useAppState";
import { openMark, reopen } from "../store/useMark";
import { resumeTask } from "../store/useTasks";
import {
  anomaliesOf,
  copyTerm,
  delRun,
  fullTerm,
  hist,
  isAtBottom,
  isRunning,
  lineFilter,
  lines,
  loadHistory,
  onTermScroll,
  pendingNew,
  scrollBottom,
  search,
  setTermEl,
  startingOf,
  statsOf,
  toggleFull,
  visibleRows,
} from "../store/useTerminal";
import ApprovalDock from "./ApprovalDock.vue";
import HighlightText from "./HighlightText.vue";

const props = defineProps<{ task: Task }>();
const id = computed(() => props.task.id);
const his = computed(() => hist.value[id.value]);
const stats = computed(() => statsOf(id.value));
const fileCount = computed(() => stats.value.files.length);
const rows = computed(() => visibleRows(id.value));
const warns = computed(() => anomaliesOf(id.value));
const pending = computed(() => pendingOf(s.value, id.value));
const latest = computed(() => pending.value[0] || null);
const resume = computed(() => needsResume(props.task, approvalForTask(s.value, id.value)));
// 漏批后的灰条：请求过期/被拒、当前没有 pending、最近 30 分钟内，dock 位置留一条出路。
const stale = computed(() => {
  if (pending.value.length || isRunning(id.value)) return null;
  const a = approvalForTask(s.value, id.value).find((x) => x.status === "expired" || x.status === "rejected");
  if (!a) return null;
  if (Date.now() - Number(a.atMs || 0) > 30 * 60 * 1000) return null;
  return a;
});
const staleHidden = ref(false);
watch(
  () => [props.task.sessionId, pending.value.length],
  () => {
    if (!pending.value.length) staleHidden.value = false;
  }
);
const fallbackResult = ref("");
const actOpen = reactive<Record<string, boolean>>({});
const foldOpen = reactive<Record<string, boolean>>({});
const openAll = ref<boolean | null>(null);

const FILTERS = [
  { key: "all", label: "全部" },
  { key: "changes", label: "只看改动" },
  { key: "errors", label: "只看错误" },
  { key: "commands", label: "只看命令" },
] as const;

function av(r: LogRow) {
  return actionView(rowAction(r));
}
function preview(r: LogRow) {
  return changePreview(rowAction(r));
}
function aOpen(r: LogRow): boolean {
  if (search.value.trim()) return true;
  if (openAll.value !== null) return openAll.value;
  if (actOpen[r.key] !== undefined) return actOpen[r.key];
  return r.kind === "cmd" && r.ok === false;
}
function toggleAct(r: LogRow) {
  actOpen[r.key] = !aOpen(r);
}
function expandAll() {
  openAll.value = true;
}
function collapseAll() {
  openAll.value = false;
}
function loadEarlier() {
  const first = Number((lines.value[id.value] || [])[0]?.seq || 0);
  if (first) loadHistory(id.value, { beforeSeq: first });
}
function remain(a: any) {
  return remainSeconds(a, nowMs.value);
}
function needsFold(r: LogRow): boolean {
  return r.text.length > 2000 || r.text.split("\n").length > 400;
}
function isFolded(r: LogRow): boolean {
  // 搜索时自动展开，避免命中内容藏在折叠区里
  return needsFold(r) && !foldOpen[r.key] && !search.value.trim();
}
function toggleFold(r: LogRow) {
  foldOpen[r.key] = !foldOpen[r.key];
}
function foldText(r: LogRow): string {
  return isFolded(r) ? r.text.slice(0, 2000) + "\n…" : r.text;
}

// 流已不在时，至少把台账里的回执全文拿出来
watch(
  () => [his.value?.source, (lines.value[id.value] || []).length, props.task.run?.id],
  async () => {
    fallbackResult.value = "";
    const h = his.value;
    if (!h || h.source !== "missing" || (lines.value[id.value] || []).length) return;
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
watch([search, lineFilter], () => {
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
      <span v-if="task.owner !== 'workbuddy'" class="badge">{{ envLabel(task.env) }}</span>
      <span class="sp"></span>
      <span v-if="isRunning(id)" class="badge live">{{ stats.durationMs ? Math.round(stats.durationMs / 1000) + "s" : "执行中" }}</span>
      <span v-if="his?.end || task.run" class="tmeta">
        {{ his?.end?.status || task.run?.status || "" }} · {{ fmtUsd(his?.end?.cost ?? task.run?.cost) }}
      </span>
      <span v-if="task.status === 'done'" class="done-badge" :title="areaText(task.area)">
        已完成<span v-if="task.workType"> · {{ typeLabel(task.workType) }} · {{ areaLabel(task.area) }}</span>
      </span>
      <button
        v-if="resume"
        class="iact resume"
        :disabled="isRunning(id)"
        title="上次会话没有干净结束（超时/被拒/失败）；点这里续接，不用回任务页"
        @click.stop="resumeTask(task)">
        接着跑
      </button>
      <button
        v-if="task.status !== 'done'"
        class="iact done"
        :disabled="isRunning(id)"
        title="跑完并核对后，点这里标注区域，任务才真正算完成"
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
        {{ fileCount }} 文件 · {{ stats.actions }} 命令 · {{ stats.errors }} 错
      </span>
      <span v-if="his?.source === 'missing' && !(lines[id] || []).length" class="anom">原始流已不在（临时流已清理），只能看回执</span>
      <span v-for="(w, i) in warns" :key="i" class="anom">{{ w.text }}</span>
      <span class="sp"></span>
      <a class="iact" :href="`/api/task/stream?id=${encodeURIComponent(id)}`" download>原始日志</a>
    </div>

    <div class="term-tools">
      <span class="chips">
        <button v-for="f in FILTERS" :key="f.key" :class="{ on: lineFilter === f.key }" @click="lineFilter = f.key">{{ f.label }}</button>
      </span>
      <span class="sp"></span>
      <button class="iact" @click="expandAll">展开全部</button>
      <button class="iact" @click="collapseAll">收起全部</button>
      <button v-if="his?.hasMore" class="iact" @click="loadEarlier">加载更早</button>
    </div>

    <div :id="`term-body-${id}`" :ref="(el) => setTermEl(id, el)" class="term-body" @scroll="onTermScroll(id)">
      <div v-if="!rows.length" class="term-wait">
        <template v-if="(lines[id] || []).length">没有匹配的日志行（换个筛选或清空搜索）</template>
        <template v-else-if="his?.source === 'missing'">
          这次的流已不在（临时流已清理），只能看回执。<template v-if="fallbackResult"> 回执如下：</template>
        </template>
        <template v-else-if="startingOf(id)">已投递，等子进程接管…</template>
        <template v-else-if="isRunning(id)">会话已启动，等待第一条输出…</template>
        <template v-else>正在加载会话…</template>
      </div>

      <div v-for="r in rows" :key="r.key" class="log-row" :class="{ err: (r.kind === 'err' || (r.kind === 'cmd' && r.ok === false)) }">
        <div v-if="r.kind === 'think'" class="l-think">
          <HighlightText :text="foldText(r)" :query="search" />
          <button v-if="needsFold(r)" class="iact fold" @click.stop="toggleFold(r)">{{ isFolded(r) ? "展开" : "收起" }}</button>
        </div>
        <div v-else-if="r.kind === 'say'" class="l-say">
          <HighlightText :text="foldText(r)" :query="search" />
          <button v-if="needsFold(r)" class="iact fold" @click.stop="toggleFold(r)">{{ isFolded(r) ? "展开" : "收起" }}</button>
        </div>
        <div v-else-if="r.kind === 'end'" class="l-end">{{ r.text }}</div>
        <pre v-else-if="r.kind === 'report'" class="l-report"><HighlightText :text="foldText(r)" :query="search" /></pre>
        <pre v-else-if="r.kind === 'out' || r.kind === 'err'" class="l-out" :class="{ 'l-err': r.kind === 'err' }"><HighlightText :text="foldText(r)" :query="search" /></pre>
        <button v-if="needsFold(r) && (r.kind === 'report' || r.kind === 'out' || r.kind === 'err')" class="iact fold" @click.stop="toggleFold(r)">{{ isFolded(r) ? "展开" : "收起" }}</button>
        <div v-else class="act-row">
          <div class="act-hd" :class="{ clickable: r.out || preview(r).length || av(r).detail }" @click="toggleAct(r)">
            <span class="aicon" :class="'k-' + av(r).kind">{{ av(r).icon }}</span>
            <span class="alabel">{{ av(r).label }}</span>
            <span class="atarget"><HighlightText :text="av(r).target" :query="search" /></span>
            <span class="atail">{{ av(r).tail }}</span>
            <span class="sp"></span>
            <span v-if="r.out || preview(r).length || av(r).detail" class="acaret">{{ aOpen(r) ? "收起" : "展开" }}</span>
          </div>
          <pre v-if="aOpen(r) && r.out" class="aout" :class="{ err: r.ok === false }"><HighlightText :text="r.out" :query="search" /></pre>
          <div v-if="aOpen(r) && preview(r).length" class="adiff">
            <div v-for="(l, i) in preview(r)" :key="i" :class="l.sign === '+' ? 'plus' : 'minus'">{{ l.sign }} {{ l.text }}</div>
          </div>
          <pre v-if="aOpen(r) && !r.out && av(r).kind === 'other' && av(r).detail" class="aout dim">{{ av(r).detail }}</pre>
        </div>
      </div>

      <div v-if="latest" class="l-wait">
        等待人工授权（{{ remain(latest) > 0 ? "剩 " + remain(latest) + "s" : "已超时" }}）· 在底部批准或拒绝
      </div>
      <pre v-if="fallbackResult" class="r-report">{{ fallbackResult }}</pre>
    </div>

    <div v-if="stale && !staleHidden" class="auth-dock stale">
      <div class="dock-line">
        <span class="pulse warn"><i></i>AUTH</span>
        <b class="dock-n">{{ stale.status === "expired" ? "已超时" : "已拒绝" }}</b>
        <span class="dock-ctx">这次调用按拒绝执行（{{ (stale.decidedAt || stale.rejectedAt || stale.at || "").slice(11, 19) }}）</span>
        <span class="sp"></span>
        <button class="iact" :disabled="isRunning(id)" @click.stop="resumeTask(task)">接着跑（续接）</button>
        <button class="iact" @click.stop="staleHidden = true">放弃</button>
      </div>
    </div>

    <ApprovalDock :task="task" />

    <button v-if="!isAtBottom(id)" class="jump" @click.stop="scrollBottom(id)">
      ↓ {{ pendingNew[id] ? pendingNew[id] + " 条新输出" : "底部" }}
    </button>
  </div>
</template>
