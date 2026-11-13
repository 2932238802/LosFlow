<script setup lang="ts">
import { computed } from "vue";
import { cmdText } from "../utils/format";
import { s } from "../store/useAppState";
import { approve, reject } from "../store/useTasks";

const pending = computed(() => (s.value?.approvals || []).filter((a) => a.status === "pending"));
</script>

<template>
  <aside class="auth-rail">
    <div class="rail-hd">
      <span class="pulse warn"><i></i>AUTH</span>
      <b>{{ pending.length }}</b><span class="tmeta">条等你批</span>
    </div>
    <div v-for="a in pending" :key="a.id" class="auth-card">
      <div class="ac-hd">Claude Code 想执行</div>
      <div class="ac-cmd">{{ cmdText(a) }}</div>
      <div class="ac-rule">建议放行 <code>{{ (a.suggested || []).join(" ") || "（无建议）" }}</code></div>
      <div class="ac-acts">
        <button class="act" @click="approve(a.id)">批准</button>
        <button class="act danger" @click="reject(a.id)">拒绝</button>
      </div>
    </div>
    <div class="rail-note">批准会写进 allowlist，并按原任务重派一次。</div>
  </aside>
</template>
