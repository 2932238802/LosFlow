<script setup lang="ts">
import type { ConfirmBits } from "../types";
import { busy, s } from "../store/useAppState";
import {
  cancelPush,
  doPush,
  openSplit,
  poolOpen,
  prio,
  pushing,
  removePool,
  setPrio,
  startPush,
  toggleConfirm,
} from "../store/usePool";
import NewTaskBox from "./NewTaskBox.vue";

// 三项确认：细则写清了吗 / 走不走标准流程 / 允许动手（授权才会推入后自动开工）
const CONFIRMS: { key: keyof ConfirmBits; label: string }[] = [
  { key: "detail", label: "细则已确认" },
  { key: "flow", label: "流程已确认" },
  { key: "auth", label: "授权执行" },
];
</script>

<template>
  <section>
    <div class="hd">任务池 <b>{{ poolOpen.length }}</b></div>
    <div v-if="!s" class="skel"><i v-for="n in 2" :key="n"></i></div>
    <div v-else-if="!poolOpen.length" class="empty">— 池子空了 —</div>
    <div v-for="it in poolOpen" :key="it.id" class="card">
      <div class="row">
        <span class="title">{{ it.title }}</span>
        <span class="sp"></span>
        <span class="pmeta">{{ it.children.length ? `已拆 ${it.children.length}` : "未拆" }}</span>
      </div>
      <div v-if="it.note" class="note">{{ it.note }}</div>
      <div class="confirms">
        <label v-for="c in CONFIRMS" :key="c.key" class="confirm">
          <input type="checkbox" :checked="!!it.confirm?.[c.key]" @change="toggleConfirm(it, c.key)" />
          <span>{{ c.label }}</span>
        </label>
        <span v-if="it.confirm?.auth" class="pmeta live">已授权 → 推入后自动开工</span>
      </div>
      <div class="acts">
        <button class="act" @click="openSplit(it)">拆分</button>
        <button class="act" :disabled="busy === 'push'" @click="startPush(it.id)" title="由 DSH 直接写入任务队列，不经过 Claude Code">
          推入 WB（我写入队列）
        </button>
        <span class="sp"></span>
        <button class="act danger" @click="removePool(it)">删除</button>
      </div>
      <div v-if="pushing === it.id" class="pushbox">
        <span class="hint" style="margin:0">优先级</span>
        <span class="seg">
          <button v-for="p in ['高', '中', '低']" :key="p" :class="{ on: prio === p }" @click="setPrio(p)">{{ p }}</button>
        </span>
        <span class="sp"></span>
        <button class="act" @click="cancelPush">取消</button>
        <button class="act" @click="doPush">确认推入</button>
      </div>
    </div>

    <NewTaskBox />
  </section>
</template>
