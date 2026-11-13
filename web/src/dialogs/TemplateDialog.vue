<script setup lang="ts">
import { computed } from "vue";
import SheetShell from "../components/SheetShell.vue";
import {
  SKILL_LABELS,
  closeTpl,
  currentSkill,
  resetTpl,
  saveTpl,
  setSkillContent,
  setSkillName,
  skillContent,
  skillItems,
  skillName,
  skillPreview,
  skillErr,
} from "../store/useSettings";

const cur = computed(() => currentSkill());
const names = computed(() => skillItems.value.map((x) => x.name));
</script>

<template>
  <SheetShell title="提示词 SKILL" @close="closeTpl">
    <div class="acts" style="margin-top:0">
      <button
        v-for="n in names"
        :key="n"
        class="act"
        :class="{ on: skillName === n }"
        @click="setSkillName(n)">
        {{ SKILL_LABELS[n] }}
      </button>
    </div>

    <div class="pmeta" style="margin-top:14px">
      文件：<code>{{ cur?.path || "docs/skills/*.md" }}</code>
      <template v-if="cur?.output === 'json-array'"> · 输出字段：<code>{{ (cur?.fields || []).join(", ") }}</code></template>
      <template v-else> · 输出：纯文本</template>
    </div>
    <div class="hint" style="margin-top:10px">
      frontmatter 决定契约：<code>---</code> 里写 <code>name / output / fields</code>；正文是系统提示。
      占位符：<code>&#123;&#123;title&#125;&#125;</code> <code>&#123;&#123;note&#125;&#125;</code> <code>&#123;&#123;extra&#125;&#125;</code> <code>&#123;&#123;schema&#125;&#125;</code>（没写会自动补在末尾）。
    </div>

    <textarea
      :value="skillContent"
      rows="14"
      spellcheck="false"
      style="font-family: var(--mono); font-size: 12.5px"
      @input="setSkillContent(($event.target as HTMLTextAreaElement).value)"></textarea>
    <div v-if="skillErr" class="hint bad" style="margin-top:10px">{{ skillErr }}</div>

    <details v-if="skillName === 'split'" style="margin-top:16px">
      <summary class="pmeta" style="cursor:pointer">最终 prompt 预览</summary>
      <pre class="cronbox" style="margin-top:10px">{{ skillPreview }}</pre>
    </details>

    <template #footer>
      <button class="act" @click="resetTpl">恢复默认</button>
      <span class="sp"></span>
      <button class="act" @click="closeTpl">关闭</button>
      <button class="act" @click="saveTpl">保存</button>
    </template>
  </SheetShell>
</template>
