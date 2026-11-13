<script setup lang="ts">
import { computed } from "vue";
import type { Task } from "../types";
import { docText, envLabel, normWorkType, pct, stageInfo, typeLabel, waitedFor, WORK_TYPES } from "../utils/format";
import { busy, nowMs } from "../store/useAppState";
import {
  delTask,
  dispatchTask,
  draftOf,
  genDocs,
  nudge,
  open,
  optInfo,
  optimizePrompt,
  setDraft,
  setRepo,
  setTaskWorkType,
  stopRun,
  toggleOpen,
} from "../store/useTasks";
import { goTerm, isRunning, runningElapsed } from "../store/useTerminal";

const props = defineProps<{ task: Task }>();
const stage = computed(() => stageInfo(props.task, isRunning(props.task.id)));
</script>

<template>
  <div class="card" :class="{ running: isRunning(task.id) }">
    <div class="row" @click="toggleOpen(task.id)">
      <span class="caret" :class="{ on: open === task.id }">›</span>
      <span class="title">#{{ task.id }} {{ task.subject }}</span>
      <span class="badge">{{ task.owner === "workbuddy" ? "WB" : "CC" }}</span>
      <span class="badge" :title="'工作类型：入池时就定，优化提示词 / 标记完成都沿用它'">{{ typeLabel(task.workType) }}</span>
      <span v-if="task.owner !== 'workbuddy'" class="badge" :title="task.envMode === 'auto' ? '按工作目录自动判定' : '项目显式指定'">
        {{ envLabel(task.env) }}
      </span>
      <span class="sp"></span>
      <span v-if="isRunning(task.id)" class="badge live">{{ runningElapsed }}s</span>
    </div>
    <div class="pbar"><div class="fill" :style="{ width: pct(task) + '%' }"></div></div>
    <div class="stage-line">
      <span class="stage-badge" :class="stage.tone">{{ stage.text }}</span>
      <span v-if="waitedFor(task, nowMs) > 0" class="pmeta">已等 {{ waitedFor(task, nowMs) }} 分钟</span>
      <span v-if="docText(task)" class="pmeta">{{ docText(task) }}</span>
      <a v-if="task.run || task.sessionId || isRunning(task.id)" class="lnk" @click.stop="goTerm(task.id)">会话 ›</a>
    </div>

    <div v-if="open === task.id" class="detail">
      <div class="pmeta" style="margin-bottom:10px">
        {{ task.repo || (task.env === "windows" ? "（未指定目录）" : "~/LosAngelous/Vesta") }}
        <span v-if="task.sessionId"> · 会话 {{ task.sessionId.slice(0, 8) }}
          <template v-if="task.sessionEnv"> · {{ envLabel(task.sessionEnv) }}</template>
        </span>
        <span v-else> · 尚未开会话</span>
        <a class="lnk" @click="setRepo(task)">改目录</a>
      </div>
      <div v-if="task.lastError" class="pmeta" style="margin-bottom:10px; color:#e08a8a">
        上次派单{{ task.lastErrorStatus === "preflight" ? "环境检查未通过，未产生花费" : "未成功（" + (task.lastErrorStatus || "error") + "）" }}：
        {{ task.lastError }}
      </div>
      <!-- Claude Code 任务：提示词发给 CC -->
      <div v-if="task.owner !== 'workbuddy'" class="promptbox">
        <div class="hint">提示词 · 发给 <b>Claude Code</b></div>
        <div class="row" style="margin:8px 0 10px; gap:10px">
          <span class="pmeta">工作类型</span>
          <div class="seg">
            <button
              v-for="w in WORK_TYPES"
              :key="w.value"
              :class="{ on: normWorkType(task.workType) === w.value }"
              :disabled="task.status === 'done'"
              @click="setTaskWorkType(task, w.value)">
              {{ w.label }}
            </button>
          </div>
        </div>
        <textarea
          :value="draftOf(task)"
          rows="3"
          @input="setDraft(task.id, ($event.target as HTMLTextAreaElement).value)"></textarea>
        <div class="acts">
          <button class="act" :disabled="busy === task.id" @click="optimizePrompt(task)">优化提示词（{{ typeLabel(task.workType) }}）</button>
          <button
            class="act"
            :disabled="busy === task.id || !!task.starting"
            @click="dispatchTask(task)">
            {{
              task.starting
                ? "启动中…"
                : task.sessionId
                  ? "发给 Claude Code（续接）"
                  : "发给 Claude Code（新会话）"
            }}
          </button>
          <span v-if="task.starting" class="pmeta live">已投递 · 等子进程接管</span>
          <span v-if="optInfo[task.id]" class="pmeta">
            已优化 {{ optInfo[task.id].at }} · ${{ Number(optInfo[task.id].cost || 0).toFixed(3) }}
          </span>
        </div>
      </div>

      <!-- WorkBuddy 任务：执行说明只读 -->
      <div v-else class="promptbox">
        <div class="hint">执行说明 · 发给 <b>WorkBuddy</b>（只读）</div>
        <pre class="note-pre">{{ task.note || task.subject }}</pre>
      </div>
      <div class="acts">
        <button v-if="task.kind === 'company'" class="act" :disabled="busy === task.id" @click="genDocs(task)">需求/交付/验收</button>
        <button v-if="task.sessionId || isRunning(task.id) || task.run" class="act" @click="goTerm(task.id)">看会话</button>
        <button v-if="task.owner === 'workbuddy' && !task.wb?.takenAt" class="act" @click="nudge(task)">催促 WB</button>
        <span class="sp"></span>
        <!-- 终止只出现在「这张卡自己在跑」时，避免在 B 卡上杀 A 的会话 -->
        <button v-if="isRunning(task.id)" class="act danger" :disabled="busy === 'stop'" @click="stopRun(task)">终止</button>
        <button class="act danger" @click="delTask(task)">删除</button>
      </div>
    </div>
  </div>
</template>
