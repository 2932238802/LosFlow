<script setup lang="ts">
import PoolPanel from "../components/PoolPanel.vue";
import TaskCard from "../components/TaskCard.vue";
import { s } from "../store/useAppState";
import { cleanup, openTasks } from "../store/useTasks";
</script>

<template>
  <section>
    <div class="hd">
      已推入 <b>{{ openTasks.length }}</b>
      <span class="sp"></span>
      <button class="act" @click="cleanup">整理主表</button>
    </div>
    <!-- state 还没回来：先给骨架，别闪「没有进行中的任务」 -->
    <div v-if="!s" class="skel"><i v-for="n in 3" :key="n"></i></div>
    <div v-else-if="!openTasks.length" class="empty">— 没有进行中的任务 —</div>
    <TaskCard v-for="t in openTasks" :key="t.id" :task="t" />
  </section>

  <PoolPanel />
</template>
