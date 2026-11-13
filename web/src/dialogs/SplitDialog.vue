<script setup lang="ts">
import RunProgress from "../components/RunProgress.vue";
import SheetShell from "../components/SheetShell.vue";
import {
  addManualLine,
  aiSplit,
  applySplit,
  closeSplit,
  optimizeSplitPrompt,
  setSplitPrompt,
  splitBusy,
  splitItem,
  splitJob,
  splitList,
  splitParseError,
  splitPrompt,
  splitRunning,
  useParentNote,
} from "../store/usePool";
import { openTpl } from "../store/useSettings";
import { WORK_TYPES } from "../utils/format";
</script>

<template>
  <SheetShell :title="`拆分 · ${splitItem?.title || ''}`" @close="closeSplit">
    <div class="hint">任务本身（可改；拆分基于这段正文，改完会先写回父条目）</div>
    <textarea :value="splitPrompt" rows="4" @input="setSplitPrompt(($event.target as HTMLTextAreaElement).value)"></textarea>
    <div class="acts">
      <button class="act" :disabled="splitBusy" @click="optimizeSplitPrompt" title="把需求补全（补路径/验收/边界），写回父条目正文，不会拆">
        补全需求
      </button>
      <button class="act" :disabled="splitBusy" @click="aiSplit">{{ splitRunning ? "拆分中…" : splitJob?.status === "ok" ? "重新拆" : "让 AI 拆" }}</button>
      <button class="act" @click="addManualLine">加一行</button>
      <span class="sp"></span>
      <button class="act" @click="openTpl">提示词 SKILL</button>
    </div>

    <!-- 进度就放在弹层里：遮罩会盖住 <main> 里的全局进度条，这里才是用户看的地方 -->
    <RunProgress
      v-if="splitRunning && splitJob"
      :label="`正在让 AI 拆 · ${splitItem?.title || ''}`"
      :since="splitJob.startedAt"
      hint="拆分在后台跑：可以关掉弹层、切到别的页面，结果会保留在池子行"
    />
    <div v-if="splitJob?.status === 'failed'" class="hint bad">上次拆分失败：{{ splitJob.error }}（可以重试）</div>
    <div v-if="splitParseError" class="hint bad">{{ splitParseError }}</div>

    <div v-if="splitList.length" class="splited">
      <div class="hint">勾选要加入池子的子任务（本体也留在池子里，地位一样；没有任务本身的不能入池）</div>
      <div v-for="(x, i) in splitList" :key="i" class="splitrow">
        <div class="splitrow-hd">
          <input v-model="x.on" type="checkbox" :disabled="!x.note.trim()" />
          <input v-model="x.title" type="text" placeholder="子任务标题" />
          <select v-model="x.workType" class="sel" title="工作类型（入池时就定）">
            <option v-for="w in WORK_TYPES" :key="w.value" :value="w.value">{{ w.label }}</option>
          </select>
          <select v-model="x.owner" class="sel">
            <option value="claude-code">CC</option>
            <option value="workbuddy">WB</option>
          </select>
        </div>
        <div v-if="x.reason" class="splitrow-reason">{{ x.reason }}</div>
        <textarea
          v-model="x.note"
          rows="3"
          :placeholder="x.note.trim() ? '任务本身' : '任务本身（必填）：做什么 / 照哪做 / 怎么验 / 要什么回执'"></textarea>
        <div class="splitrow-acts">
          <span v-if="!x.note.trim()" class="hint bad" style="margin:0">先补任务本身才能勾选</span>
          <button class="act" @click="useParentNote(i)">沿用父任务正文</button>
        </div>
      </div>
    </div>

    <template #footer>
      <button class="act" @click="closeSplit">关闭</button>
      <button
        class="act"
        :disabled="splitBusy || !splitList.some((x) => x.on && x.title.trim()) || splitList.some((x) => x.on && x.title.trim() && !x.note.trim())"
        @click="applySplit">
        加入池子
      </button>
    </template>
  </SheetShell>
</template>
