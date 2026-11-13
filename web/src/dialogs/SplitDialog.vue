<script setup lang="ts">
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
  splitList,
  splitPrompt,
} from "../store/usePool";
import { openTpl } from "../store/useSettings";
</script>

<template>
  <SheetShell :title="`拆分 · ${splitItem?.title || ''}`" @close="closeSplit">
    <div class="hint">需求/提示词（可改，改完让 AI 拆）</div>
    <textarea :value="splitPrompt" rows="4" @input="setSplitPrompt(($event.target as HTMLTextAreaElement).value)"></textarea>
    <div class="acts">
      <button class="act" :disabled="splitBusy" @click="optimizeSplitPrompt">优化</button>
      <button class="act" :disabled="splitBusy" @click="aiSplit">让 AI 拆</button>
      <button class="act" @click="addManualLine">加一行</button>
      <span class="sp"></span>
      <button class="act" @click="openTpl">优化SKILL设置</button>
    </div>

    <div v-if="splitList.length" class="splited">
      <div class="hint">勾选要加入池子的子任务（本体也留在池子里，地位一样）</div>
      <div v-for="(x, i) in splitList" :key="i" class="splitrow">
        <input type="checkbox" v-model="x.on" />
        <input type="text" v-model="x.title" placeholder="子任务标题" />
        <select v-model="x.owner" class="sel">
          <option value="claude-code">CC</option>
          <option value="workbuddy">WB</option>
        </select>
      </div>
    </div>

    <template #footer>
      <button class="act" @click="closeSplit">取消</button>
      <button class="act" :disabled="splitBusy || !splitList.length" @click="applySplit">加入池子</button>
    </template>
  </SheetShell>
</template>
