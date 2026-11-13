<script setup lang="ts">
import SheetShell from "../components/SheetShell.vue";
import { s } from "../store/useAppState";
import { closePick, newProject, openProj, pickProject } from "../store/useProjects";
</script>

<template>
  <SheetShell title="选项目" @close="closePick">
    <div class="dirs" style="max-height:320px">
      <div v-for="pr in s?.projects || []" :key="pr.id" class="dir" :class="{ picked: pr.path === newProject }" @click="pickProject(pr.path)">
        {{ pr.name }} <span class="pmeta">{{ pr.path }}</span>
      </div>
      <div v-if="!(s?.projects || []).length" class="empty">— 还没有项目 —</div>
    </div>
    <template #footer>
      <button class="act" @click="closePick(); openProj()">＋ 新项目</button>
      <button class="act" @click="closePick">关闭</button>
    </template>
  </SheetShell>
</template>
