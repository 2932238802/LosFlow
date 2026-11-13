<script setup lang="ts">
import { s } from "../store/useAppState";
import { poolDone } from "../store/usePool";
import { doneTasks } from "../store/useTasks";
import { areaLabel, typeLabel } from "../utils/format";
</script>

<template>
  <div class="hd">已完成 <b>{{ doneTasks.length }}</b></div>
  <div v-if="!s" class="skel"><i v-for="n in 3" :key="n"></i></div>
  <div v-else-if="!doneTasks.length" class="empty">— 还没有已完成的任务 —</div>
  <div v-for="t in doneTasks" :key="t.id" class="card" style="padding:12px 0">
    <div class="row">
      <span class="title" style="font-size:14px">#{{ t.id }} {{ t.subject }}</span>
      <span v-if="t.workType" class="pmeta">{{ typeLabel(t.workType) }} · {{ areaLabel(t.area) }}</span>
      <span class="sp"></span>
      <span class="pmeta">{{ t.evidence ? t.evidence.slice(0, 40) : "无证据" }}</span>
    </div>
    <div v-if="t.area?.path" class="pmeta" style="margin-top:6px">{{ t.area.path }}</div>
  </div>
  <div class="hd" style="margin-top:36px">归档的池子 <b>{{ poolDone.length }}</b></div>
  <div v-for="it in poolDone" :key="it.id" class="card" style="padding:10px 0">
    <div class="row">
      <span class="title" style="font-size:14px">{{ it.title }}</span>
      <span class="sp"></span>
      <span class="pmeta">{{ it.priority || "中" }} · #{{ it.pushTaskId }}</span>
    </div>
  </div>
</template>
