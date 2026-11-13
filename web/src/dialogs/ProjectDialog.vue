<script setup lang="ts">
import SheetShell from "../components/SheetShell.vue";
import { browse, closeProj, projDirs, projErr, projName, projParent, projPath, saveProj, setProjName } from "../store/useProjects";

function enterDir(d: string) {
  browse(projPath.value.endsWith("/") ? projPath.value + d : projPath.value + "/" + d);
}
</script>

<template>
  <SheetShell title="添加项目" @close="closeProj">
    <div class="hint">项目名</div>
    <input type="text" :value="projName" placeholder="比如 Vesta / LosPool" @input="setProjName(($event.target as HTMLInputElement).value)" />
    <div class="hint" style="margin-top:16px">目录（点文件夹进入，选好后确认）</div>
    <div class="pmeta" style="margin-bottom:10px">{{ projPath }}</div>
    <div class="acts" style="margin-top:0">
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
