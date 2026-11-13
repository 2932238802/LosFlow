<script setup lang="ts">
import SheetShell from "../components/SheetShell.vue";
import {
  browse,
  closeProj,
  projDirs,
  projEnv,
  projErr,
  projName,
  projParent,
  projPath,
  saveProj,
  setProjEnv,
  setProjName,
  setProjPath,
} from "../store/useProjects";

function enterDir(d: string) {
  browse(projPath.value.endsWith("/") ? projPath.value + d : projPath.value + "/" + d);
}
</script>

<template>
  <SheetShell title="添加项目" @close="closeProj">
    <div class="hint">项目名</div>
    <input type="text" :value="projName" placeholder="比如 Vesta / LosPool" @input="setProjName(($event.target as HTMLInputElement).value)" />

    <div class="hint" style="margin-top:16px">环境（决定派单用哪个 Claude Code）</div>
    <div class="acts" style="margin-top:0">
      <button class="act" :class="{ on: projEnv === 'auto' }" @click="setProjEnv('auto')">自动判定</button>
      <button class="act" :class="{ on: projEnv === 'wsl' }" @click="setProjEnv('wsl')">WSL2</button>
      <button class="act" :class="{ on: projEnv === 'windows' }" @click="setProjEnv('windows')">Windows</button>
    </div>
    <div class="pmeta" style="margin-top:8px">
      自动判定：<code>~/</code> / <code>/</code> 开头 → WSL2；<code>D:\</code> / <code>\\</code> 开头 → Windows。
    </div>

    <div class="hint" style="margin-top:16px">目录（可直接填写，或用下面浏览 WSL 目录）</div>
    <input type="text" :value="projPath" placeholder="D:\PROJECT\Foo 或 ~/LosAngelous/Vesta" @input="setProjPath(($event.target as HTMLInputElement).value)" />
    <div class="acts" style="margin-top:12px">
      <button class="act" @click="browse('~')">~ 主页</button>
      <button class="act" v-if="projParent" @click="browse(projParent)">↑ 上一层</button>
      <span v-if="projErr" class="pmeta">{{ projErr }}</span>
    </div>
    <div class="dirs">
      <div v-for="d in projDirs" :key="d" class="dir" @click="enterDir(d)">{{ d }}/</div>
      <div v-if="!projDirs.length" class="empty">— 这里没有子目录 —</div>
    </div>
    <template #footer>
      <button class="act" @click="closeProj">取消</button>
      <button class="act" @click="saveProj">选用此目录</button>
    </template>
  </SheetShell>
</template>
