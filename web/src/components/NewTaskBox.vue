<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { busy } from "../store/useAppState";
import { registerNewTaskFocus } from "../store/useFocus";
import { add, newBody, newTitle, optimizeDraft, setNewBody, setNewTitle } from "../store/usePool";
import { currentProjectName, openPick, openProj } from "../store/useProjects";
import { openTpl } from "../store/useSettings";

const inputEl = ref<HTMLInputElement | null>(null);
onMounted(() =>
  registerNewTaskFocus(() => {
    inputEl.value?.focus();
    inputEl.value?.select();
  })
);
onBeforeUnmount(() => registerNewTaskFocus(null));
</script>

<template>
  <div class="newtask">
    <div class="hint">任务标题</div>
    <input
      ref="inputEl"
      :value="newTitle"
      type="text"
      placeholder="一句话标题，比如：修复问卷跳题"
      @input="setNewTitle(($event.target as HTMLInputElement).value)"
      @keydown.enter="add" />
    <div class="hint" style="margin-top:12px">任务本身 · 真正发给 Claude Code 的提示词</div>
    <textarea
      :value="newBody"
      rows="3"
      placeholder="写清：做什么 / 照哪份文档 / 怎么验 / 要什么回执"
      @input="setNewBody(($event.target as HTMLTextAreaElement).value)"></textarea>
    <div class="acts" style="margin-top:12px">
      <button class="act" :disabled="busy === 'draft'" @click="optimizeDraft">优化提示词</button>
      <button class="act" @click="openTpl">优化提示词 SKILL</button>
    </div>
    <div class="add">
      <button class="selbtn" @click="openPick">{{ currentProjectName }}</button>
      <button class="act" @click="add">加入池</button>
      <button class="act" @click="openProj">＋项目</button>
    </div>
  </div>
</template>
