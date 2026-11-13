<script setup lang="ts">
import { busy, s } from "../store/useAppState";
import { delProj, openProj } from "../store/useProjects";
import { buildCronPrompt, cronPrompt, purge, saveThreshold, setThreshold, threshold } from "../store/useSettings";
import { fmtBytes } from "../utils/format";
</script>

<template>
  <div class="hd">历史会话 <b>{{ s?.history?.runs || 0 }}</b></div>
  <div class="card" style="padding:14px 0">
    <div class="row">
      <span class="title" style="font-size:15px">runs / streams 归档</span>
      <span class="sp"></span>
      <span class="pmeta">{{ s?.history?.runs || 0 }} 条回执 · {{ s?.history?.streams || 0 }} 条回放 · {{ fmtBytes(s?.history?.bytes || 0) }}</span>
    </div>
    <div class="note">终端回放优先读 <code>data/streams</code>（派单结束时从 WSL <code>/tmp</code> 归档），没有才回退 WSL；清理时会连 WSL <code>/tmp</code> 里的 <code>cc-*</code> 一起删（台账、任务表、池子不动）。</div>
    <div class="acts">
      <button class="act" :disabled="busy === 'purge'" @click="purge(24)">清理 24 小时前</button>
      <button class="act" :disabled="busy === 'purge'" @click="purge(168)">清理 7 天前</button>
      <button class="act danger" :disabled="busy === 'purge'" @click="purge(0.01)">全清（1 分钟前）</button>
    </div>
  </div>

  <div class="hd" style="margin-top:44px">已放行的规则 <b>{{ (s?.allowlist || []).length }}</b></div>
  <div class="log">
    <div v-if="!(s?.allowlist || []).length" class="empty">— 还没有放行过 —</div>
    <div v-for="(r, i) in s?.allowlist || []" :key="i" class="line">
      <time>规则</time><span><code>{{ r }}</code></span>
    </div>
  </div>

  <div class="hd" style="margin-top:44px">项目 <b>{{ s?.projects?.length || 0 }}</b></div>
  <div v-for="pr in s?.projects || []" :key="pr.id" class="card" style="padding:14px 0">
    <div class="row">
      <span class="title" style="font-size:16px">{{ pr.name }}</span>
      <span class="pmeta">{{ pr.path }}</span>
      <span class="sp"></span>
      <button class="act danger" @click="delProj(pr.id)">删除</button>
    </div>
  </div>
  <div class="acts" style="margin-top:18px">
    <button class="act" @click="openProj">＋ 添加项目（浏览 WSL 目录）</button>
  </div>

  <div class="hd" style="margin-top:52px">自动整理主表</div>
  <div class="card">
    <div class="row" style="cursor:default; gap:12px; align-items:center">
      <span>每完成</span>
      <input
        :value="threshold"
        type="number"
        min="0"
        max="99"
        class="num"
        @input="setThreshold(($event.target as HTMLInputElement).value)" />
      <span>条任务，自动建一次整理任务（0 = 关闭）</span>
      <span class="sp"></span>
      <button class="act" @click="saveThreshold">保存</button>
    </div>
    <div class="pmeta" style="margin-top:10px">
      已累计 {{ s?.maintenance?.count || 0 }} 条 · 上次整理 {{ (s?.maintenance?.lastAt || "").slice(0, 16) || "从未" }}
    </div>
  </div>

  <div class="hd" style="margin-top:52px">定时整理（WorkBuddy 侧）</div>
  <div class="card">
    <div class="pmeta">在 WorkBuddy 里建一个每天执行的定时任务，指令用下面这段：</div>
    <div class="acts" style="margin-top:16px"><button class="act" @click="buildCronPrompt">生成指令</button></div>
    <pre v-if="cronPrompt" class="cronbox">{{ cronPrompt }}</pre>
  </div>
</template>
