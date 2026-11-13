<script setup lang="ts">
import { computed, onMounted } from "vue";
import AuthRail from "../components/AuthRail.vue";
import { busy, s } from "../store/useAppState";
import { delProj, openProj } from "../store/useProjects";
import {
  buildCronPrompt,
  cfg,
  cfgEnvKeys,
  cronPrompt,
  loadConfig,
  purge,
  saveConfig,
  saveThreshold,
  setThreshold,
  threshold,
} from "../store/useSettings";
import { envLabel, fmtBytes } from "../utils/format";

onMounted(loadConfig);

const notifyText = computed(() => {
  const n = s.value?.notify;
  if (!n) return "未知";
  if (!n.enabled) return "已关闭";
  if (n.ok === false) return `不可用${n.lastError ? "：" + n.lastError : ""}`;
  return `可用 · ${n.mode || "auto"}${n.lastAt ? " · 上次 " + String(n.lastAt).slice(11, 19) : ""}`;
});
</script>

<template>
  <div class="hd">历史会话 <b>{{ s?.history?.runs || 0 }}</b></div>
  <div class="card" style="padding:14px 0">
    <div class="row">
      <span class="title" style="font-size:15px">runs / streams 归档</span>
      <span class="sp"></span>
      <span class="pmeta">{{ s?.history?.runs || 0 }} 条回执 · {{ s?.history?.streams || 0 }} 条回放 · {{ fmtBytes(s?.history?.bytes || 0) }}</span>
    </div>
    <div class="note">终端回放优先读 <code>data/streams</code>（派单结束时归档）；没有才回退运行中的流（WSL <code>/tmp</code> 或 Windows <code>data/runstate</code>）。清理时会连临时流与运行态一起删（台账、任务表、池子不动）。</div>
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

  <div class="hd" style="margin-top:44px">授权记录 <b>{{ (s?.approvals || []).length }}</b></div>
  <details class="card">
    <summary style="cursor:pointer">最近 {{ (s?.approvals || []).length }} 条（含已批准 / 拒绝 / 超时）</summary>
    <div style="margin-top:16px"><AuthRail history /></div>
  </details>

  <div class="hd" style="margin-top:44px">项目 <b>{{ s?.projects?.length || 0 }}</b></div>
  <div v-for="pr in s?.projects || []" :key="pr.id" class="card" style="padding:14px 0">
    <div class="row">
      <span class="title" style="font-size:16px">{{ pr.name }}</span>
      <span class="badge">{{ envLabel(pr.resolvedEnv) }}</span>
      <span v-if="(pr.env || 'auto') === 'auto'" class="pmeta">自动判定</span>
      <span class="pmeta">{{ pr.path }}</span>
      <span class="sp"></span>
      <button class="act danger" @click="delProj(pr.id)">删除</button>
    </div>
  </div>
  <div class="acts" style="margin-top:18px">
    <button class="act" @click="openProj">＋ 添加项目（WSL 目录 / 手填 Windows 路径）</button>
  </div>

  <div class="hd" style="margin-top:52px">派单环境</div>
  <div class="card">
    <div class="row" style="cursor:default; gap:12px; align-items:center">
      <span>未指定目录时默认走</span>
      <select v-model="cfg.defaultEnv" class="sel">
        <option value="wsl">WSL2</option>
        <option value="windows">Windows</option>
      </select>
      <span class="pmeta">仅对 repo 为空的老任务生效；有路径时按路径形态判定</span>
    </div>
    <div class="row" style="cursor:default; gap:12px; align-items:center; margin-top:14px">
      <span>Windows claude.exe</span>
      <input
        type="text"
        :value="cfg.windowsClaudeCmd"
        placeholder="留空自动解析（npm / ~/.claude/bin）"
        style="flex:1"
        @input="cfg.windowsClaudeCmd = ($event.target as HTMLInputElement).value" />
    </div>
    <div class="row" style="cursor:default; gap:12px; align-items:center; margin-top:14px">
      <span>单次派单超时（秒）</span>
      <input
        type="number"
        min="30"
        max="3600"
        class="num"
        :value="cfg.claudeTimeoutSec"
        @input="cfg.claudeTimeoutSec = Number(($event.target as HTMLInputElement).value) || 600" />
      <span class="sp"></span>
      <button class="act" @click="saveConfig">保存</button>
    </div>
    <div class="pmeta" style="margin-top:12px">
      注入给 Windows 子进程的网关变量：
      <code v-if="cfgEnvKeys.length">{{ cfgEnvKeys.join(" / ") }}</code>
      <span v-else>未配置（继承本机环境 / 已登录账号）</span>
      · 值只写在 <code>losflow.config.json</code> 的 <code>windowsClaudeEnv</code>，界面不读取也不保存
    </div>
  </div>

  <div class="hd" style="margin-top:52px">Windows 提醒</div>
  <div class="card">
    <div class="row" style="cursor:default; gap:12px; align-items:center">
      <span>授权通知</span>
      <b>{{ notifyText }}</b>
      <span class="sp"></span>
      <span class="pmeta">新请求入队即弹通知 + 声音；20s 未处理再响一次；配置见 <code>losflow.config.json</code> 的 <code>notify</code></span>
    </div>
    <div class="pmeta" style="margin-top:10px">
      服务必须跑在登录会话里（<code>npm start</code>），做成 Windows 服务（session 0）时气球不会出现。
    </div>
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
