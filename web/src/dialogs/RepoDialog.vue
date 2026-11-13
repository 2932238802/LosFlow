<script setup lang="ts">
import SheetShell from "../components/SheetShell.vue";
import {
  browseRepo,
  chooseRepo,
  closeRepo,
  repoDirs,
  repoEnv,
  repoErr,
  repoFor,
  repoParent,
  repoPath,
  setRepoEnv,
  setRepoPath,
} from "../store/useProjects";
import { joinPath } from "../utils/format";

function enterDir(d: string) {
  browseRepo(joinPath(repoPath.value, d));
}
</script>

<template>
  <SheetShell :title="`工作目录 · #${repoFor?.id || ''} ${repoFor?.subject || ''}`" @close="closeRepo">
    <div class="hint">Claude Code 在这个目录里干活</div>
    <div class="acts" style="margin-top:0">
      <button class="act" :class="{ on: repoEnv === 'auto' }" @click="setRepoEnv('auto')">自动判定</button>
      <button class="act" :class="{ on: repoEnv === 'wsl' }" @click="setRepoEnv('wsl')">WSL2</button>
      <button class="act" :class="{ on: repoEnv === 'windows' }" @click="setRepoEnv('windows')">Windows</button>
    </div>
    <input
      type="text"
      :value="repoPath"
      placeholder="D:\PROJECT\Foo 或 ~/LosAngelous/Vesta"
      style="margin-top:12px"
      @input="setRepoPath(($event.target as HTMLInputElement).value)" />
    <div class="pmeta" style="margin:8px 0 12px">
      自动判定：<code>~/</code> / <code>/</code> 开头 → WSL2；<code>D:\</code> / <code>\\</code> 开头 → Windows。下面是 WSL 目录浏览。
    </div>
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
