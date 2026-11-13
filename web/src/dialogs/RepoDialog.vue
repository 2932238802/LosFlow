<script setup lang="ts">
import SheetShell from "../components/SheetShell.vue";
import { browseRepo, chooseRepo, closeRepo, repoDirs, repoErr, repoFor, repoParent, repoPath } from "../store/useProjects";
import { joinPath } from "../utils/format";

function enterDir(d: string) {
  browseRepo(joinPath(repoPath.value, d));
}
</script>

<template>
  <SheetShell :title="`工作目录 · #${repoFor?.id || ''} ${repoFor?.subject || ''}`" @close="closeRepo">
    <div class="hint">Claude Code 在这个目录里干活（WSL 路径）</div>
    <div class="pmeta" style="margin:8px 0 12px">{{ repoPath }}</div>
    <div class="acts" style="margin-top:0">
      <button class="act" @click="browseRepo('~')">~ 主页</button>
      <button class="act" v-if="repoParent" @click="browseRepo(repoParent)">↑ 上一层</button>
      <span v-if="repoErr" class="pmeta">{{ repoErr }}</span>
    </div>
    <div class="dirs">
      <div v-for="d in repoDirs" :key="d" class="dir" @click="enterDir(d)">{{ d }}/</div>
      <div v-if="!repoDirs.length" class="empty">— 这里没有子目录 —</div>
    </div>
    <template #footer>
      <button class="act" @click="closeRepo">取消</button>
      <button class="act" @click="chooseRepo">选用此目录</button>
    </template>
  </SheetShell>
</template>
