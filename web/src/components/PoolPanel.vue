<script setup lang="ts">
import { computed } from "vue";
import type { PoolItem } from "../types";
import { busy, nowMs, s } from "../store/useAppState";
import { jobFor } from "../store/useJobs";
import {
  beginEditNote,
  cancelEditNote,
  cancelPush,
  doPush,
  editingNote,
  noteDraft,
  openSplit,
  poolOpen,
  prio,
  pushing,
  removePool,
  saveNote,
  setNoteDraft,
  setPrio,
  setWorkType,
  splitCount,
  startPush,
} from "../store/usePool";
import { WORK_TYPES } from "../utils/format";
import NewTaskBox from "./NewTaskBox.vue";

// 拆分作业在池子行上直接可见：关掉弹层、切页、刷新后都能看到「还在跑」或「有结果」。
// 每次渲染只算一遍（poolOpen 通常只有几十条），避免模板里反复遍历作业表。
const jobByItem = computed(() => {
  const out: Record<string, ReturnType<typeof jobFor>> = {};
  for (const it of poolOpen.value) out[it.id] = jobFor(it.id);
  return out;
});

const allPool = computed(() => s.value?.pool || []);
function pushedCount(it: PoolItem) {
  if (Array.isArray(it.pushedTaskIds) && it.pushedTaskIds.length) return it.pushedTaskIds.length;
  if (it.pushTaskId) return String(it.pushTaskId).split(",").filter(Boolean).length;
  return 0;
}
function notePreview(note?: string) {
  const lines = String(note || "").split("\n").filter((x) => x.trim()).slice(0, 2);
  const text = lines.join("\n");
  return text.length > 180 ? text.slice(0, 180) + "…" : text;
}
function childCount(it: PoolItem) {
  return (it.children || []).filter((cid) => allPool.value.some((p) => p.id === cid && p.parent === it.id)).length;
}
// 还没推入的子任务数：都推完了就把按钮停掉，避免点了才报错
function pendingChildren(it: PoolItem) {
  return (it.children || []).filter((cid) => {
    const child = allPool.value.find((p) => p.id === cid && p.parent === it.id);
    return child && !child.pushTaskId;
  }).length;
}
// 父记录过子任务，但子条目都已被删：不能让推入退化成按父标题再建一条
function lostChildren(it: PoolItem) {
  return (it.children || []).length > 0 && childCount(it) === 0;
}
// 待推入的子任务里还有没写正文的：推入会整批被后端拒绝，这里先拦住
function unreadyChildren(it: PoolItem) {
  return (it.children || []).filter((cid) => {
    const child = allPool.value.find((p) => p.id === cid && p.parent === it.id);
    return child && !child.pushTaskId && !String(child.note || "").trim();
  }).length;
}

function splitElapsed(startedAt: number) {
  return Math.max(0, Math.round((nowMs.value - Number(startedAt || Date.now())) / 1000));
}
</script>

<template>
  <section>
    <div class="hd">任务池 <b>{{ poolOpen.length }}</b></div>
    <div v-if="!s" class="skel"><i v-for="n in 2" :key="n"></i></div>
    <div v-else-if="!poolOpen.length" class="empty">— 池子空了 —</div>
    <div v-for="it in poolOpen" :key="it.id" class="card">
      <div class="row">
        <span class="title">{{ it.title }}</span>
        <span v-if="it.parent" class="badge">子任务</span>
        <span class="sp"></span>
        <span v-if="jobByItem[it.id]?.status === 'running'" class="pmeta live">
          拆分中 {{ splitElapsed(jobByItem[it.id]?.startedAt || 0) }}s
        </span>
        <button v-else-if="jobByItem[it.id]?.status === 'ok'" class="act" @click="openSplit(it)">
          有拆分结果（{{ splitCount(jobByItem[it.id]) }} 条）· 查看
        </button>
        <span v-else-if="jobByItem[it.id]?.status === 'failed'" class="pmeta" :title="jobByItem[it.id]?.error || ''">
          拆分失败 · 可重试
        </span>
        <span v-if="!it.parent" class="pmeta">{{ childCount(it) ? `已拆 ${childCount(it)}` : "未拆" }}</span>
        <span v-if="pushedCount(it)" class="pmeta">已推 {{ pushedCount(it) }}</span>
      </div>

      <div v-if="editingNote === it.id" class="note-edit">
        <textarea
          :value="noteDraft"
          rows="4"
          placeholder="任务本身（真正发给 Claude Code 的正文）"
          @input="setNoteDraft(($event.target as HTMLTextAreaElement).value)"></textarea>
        <div class="acts">
          <button class="act" @click="cancelEditNote">取消</button>
          <button class="act" @click="saveNote(it)">保存正文</button>
        </div>
      </div>
      <div v-else-if="it.note" class="note" :title="it.note">{{ notePreview(it.note) }}</div>
      <div v-else class="note pmeta">— 还没有任务本身 —</div>

      <div class="row" style="margin-top:12px; gap:10px">
        <span class="pmeta">工作类型</span>
        <div class="seg">
          <button
            v-for="w in WORK_TYPES"
            :key="w.value"
            :class="{ on: (it.workType || 'dev') === w.value }"
            @click="setWorkType(it, w.value)">
            {{ w.label }}
          </button>
        </div>
      </div>

      <div class="acts">
        <button v-if="!it.parent" class="act" @click="openSplit(it)">拆分</button>
        <button v-else class="act" @click="beginEditNote(it)">编辑正文</button>
        <button
          class="act"
          :disabled="
            busy === 'push' ||
            lostChildren(it) ||
            unreadyChildren(it) > 0 ||
            (childCount(it) > 0 && pendingChildren(it) === 0) ||
            (childCount(it) === 0 && !String(it.note || '').trim())
          "
          :title="
            lostChildren(it)
              ? '子任务都已删除，请重新拆分'
              : unreadyChildren(it) > 0
                ? `还有 ${unreadyChildren(it)} 条子任务没有正文，先补`
                : childCount(it) && pendingChildren(it) === 0
                  ? '子任务都已推入'
                  : childCount(it) === 0 && !String(it.note || '').trim()
                    ? '先补任务本身（编辑正文）'
                    : '落库后按「任务本身」自动派给 Claude Code（WorkBuddy 任务等 WB 取走）'
          "
          @click="startPush(it.id)">
          {{
            lostChildren(it)
              ? "子任务已删除"
              : childCount(it)
                ? pendingChildren(it)
                  ? `推入并开工（${pendingChildren(it)}）`
                  : "子任务已全部推入"
                : String(it.note || "").trim()
                  ? "推入并开工"
                  : "先补正文"
          }}
        </button>
        <span class="sp"></span>
        <button v-if="!it.parent" class="act" @click="beginEditNote(it)">编辑正文</button>
        <button class="act danger" @click="removePool(it)">删除</button>
      </div>
      <div v-if="pushing === it.id" class="pushbox">
        <span class="hint" style="margin:0">优先级</span>
        <span class="seg">
          <button v-for="p in ['高', '中', '低']" :key="p" :class="{ on: prio === p }" @click="setPrio(p)">{{ p }}</button>
        </span>
        <span class="sp"></span>
        <button class="act" @click="cancelPush">取消</button>
        <button class="act" @click="doPush">确认推入</button>
      </div>
    </div>

    <NewTaskBox />
  </section>
</template>
