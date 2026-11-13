<script setup lang="ts">
import SheetShell from "../components/SheetShell.vue";
import { closeSheet, copySheet, sheet } from "../store/useTasks";
</script>

<template>
  <SheetShell :title="sheet?.title || ''" @close="closeSheet">
    <template v-if="sheet?.json">
      <div v-if="sheet.json.requirement" class="sect"><h4>需求描述</h4><pre>{{ sheet.json.requirement }}</pre></div>
      <div v-if="sheet.json.deliverables" class="sect">
        <h4>交付事项</h4>
        <ul><li v-for="(x, i) in sheet.json.deliverables" :key="i">{{ x }}</li></ul>
      </div>
      <div v-if="sheet.json.acceptance" class="sect">
        <h4>验收事项</h4>
        <ul><li v-for="(x, i) in sheet.json.acceptance" :key="i">{{ x }}</li></ul>
      </div>
      <div v-if="Array.isArray(sheet.json)" class="sect">
        <h4>建议</h4>
        <ul><li v-for="(x, i) in sheet.json" :key="i">{{ x.title }} <span class="badge">{{ x.owner }}</span></li></ul>
      </div>
    </template>
    <pre v-else>{{ sheet?.body }}</pre>
    <template #footer>
      <button class="act" @click="copySheet">复制</button>
      <button class="act" @click="closeSheet">关闭</button>
    </template>
  </SheetShell>
</template>
