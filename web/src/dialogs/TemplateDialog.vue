<script setup lang="ts">
import SheetShell from "../components/SheetShell.vue";
import { closeTpl, saveTpl, tpl } from "../store/useSettings";
</script>

<template>
  <SheetShell title="优化 SKILL 设置" @close="closeTpl">
    <div class="hint">拆分用的系统提示</div>
    <textarea v-model="tpl.splitSystem" rows="4"></textarea>
    <div class="hint" style="margin-top:16px">改写提示词用的系统提示</div>
    <textarea v-model="tpl.optimizeSystem" rows="4"></textarea>
    <template #footer>
      <button class="act" @click="closeTpl">取消</button>
      <button class="act" @click="saveTpl">保存</button>
    </template>
  </SheetShell>
</template>
