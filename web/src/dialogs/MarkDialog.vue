<script setup lang="ts">
import SheetShell from "../components/SheetShell.vue";
import {
  browseDocs,
  closeMark,
  markBusy,
  markDirs,
  markErr,
  markFor,
  markForm,
  markParent,
  pickAreaKind,
  submitMark,
} from "../store/useMark";
import { docsDefault, joinPath, typeLabel } from "../utils/format";
</script>

<template>
  <SheetShell :title="`标记完成 · #${markFor?.id || ''} ${markFor?.subject || ''}`" @close="closeMark">
    <div class="hint">工作类型（入池时就定了）</div>
    <div class="pmeta" style="margin-top:4px">类型：{{ typeLabel(markFor?.workType) }} · 需要改就去任务卡上改</div>

    <div class="hint" style="margin-top:22px">动的是哪块（区域）</div>
    <div class="seg">
      <button :class="{ on: markForm.areaKind === 'code' }" @click="pickAreaKind('code')">代码区</button>
      <button :class="{ on: markForm.areaKind === 'docs' }" @click="pickAreaKind('docs')">文档区</button>
    </div>

    <div v-if="markForm.areaKind === 'docs'" style="margin-top:16px">
      <div class="hint">文档路径（默认任务仓库下的 docs/，可逐级选）</div>
      <input type="text" v-model="markForm.path" placeholder="~/LosAngelous/Vesta/docs" />
      <div class="acts" style="margin-top:10px">
        <button class="act" @click="browseDocs(markForm.path)">浏览此路径</button>
        <button class="act" @click="browseDocs('~')">~ 主页</button>
        <button v-if="markParent" class="act" @click="browseDocs(markParent)">↑ 上一层</button>
        <button v-if="markFor" class="act" @click="browseDocs(docsDefault(markFor))">项目 docs</button>
        <span v-if="markErr" class="pmeta">{{ markErr }}</span>
      </div>
      <div class="dirs">
        <div v-for="d in markDirs" :key="d" class="dir" @click="browseDocs(joinPath(markForm.path, d))">{{ d }}/</div>
        <div v-if="!markDirs.length" class="empty">— 这里没有子目录 —</div>
      </div>
    </div>
    <div v-else class="pmeta" style="margin-top:12px">代码区：{{ markForm.path || "任务目录" }}</div>

    <div class="hint" style="margin-top:22px">证据（写进本地任务表，面板里可改）</div>
    <textarea v-model="markForm.evidence" rows="5" placeholder="结论 / 改了哪些文件 / 怎么验的"></textarea>
    <div class="pmeta" style="margin-top:8px">
      证据只存在本地任务表（data/Vesta.tasks.json）；腾讯文档那行只回填「任务状态 + 备注（类型 · 区域）」。
    </div>
    <div v-if="markErr && markForm.areaKind !== 'docs'" class="pmeta" style="margin-top:8px">{{ markErr }}</div>

    <template #footer>
      <button class="act" @click="closeMark">取消</button>
      <button class="act" :disabled="markBusy" @click="submitMark">确认完成</button>
    </template>
  </SheetShell>
</template>
