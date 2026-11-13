<script setup lang="ts">
import SheetShell from "../components/SheetShell.vue";
import { answerConfirm, confirmReq } from "../store/useConfirm";
</script>

<template>
  <SheetShell v-if="confirmReq" :title="confirmReq.title" @close="answerConfirm(false)">
    <div v-if="confirmReq.body" class="note" style="margin-top:0">{{ confirmReq.body }}</div>
    <div v-if="confirmReq.detail" class="pmeta" style="margin-top:14px; white-space: pre-wrap">{{ confirmReq.detail }}</div>
    <template #footer>
      <button class="act" @click="answerConfirm(false)">{{ confirmReq.cancelText || "取消" }}</button>
      <button class="act" :class="{ danger: confirmReq.danger }" @click="answerConfirm(true)">
        {{ confirmReq.okText || "确定" }}
      </button>
    </template>
  </SheetShell>
</template>
