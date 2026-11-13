<script setup lang="ts">
import { reactive, watch } from "vue";
import type { ConnectorView } from "../types";
import { connectorList, replayConnector, saveConnector, testConnector } from "../store/useConnectors";
import { flash } from "../store/useToast";

type Draft = {
  enabled: boolean;
  targetUrl: string;
  mappingText: string;
  actions: string[];
  maxAttempts: number;
  staleMs: number;
  secret: string;
  clearSecret: boolean;
};

const list = connectorList;
const drafts = reactive<Record<string, Draft>>({});

function initDrafts(items: ConnectorView[]) {
  for (const c of items) {
    if (drafts[c.id]) continue;
    drafts[c.id] = {
      enabled: !!c.enabled,
      targetUrl: String(c.target?.url || c.target?.dir || ""),
      mappingText: JSON.stringify(c.mapping || {}, null, 2),
      actions: [...(c.actions || c.capabilities || [])],
      maxAttempts: Number(c.queue?.maxAttempts) || 3,
      staleMs: Number(c.queue?.staleMs) || 900000,
      secret: "",
      clearSecret: false,
    };
  }
}
watch(list, initDrafts, { immediate: true });

function toggleAction(c: ConnectorView, action: string) {
  const d = drafts[c.id];
  if (!d) return;
  d.actions = d.actions.includes(action) ? d.actions.filter((x) => x !== action) : [...d.actions, action];
}

async function save(c: ConnectorView) {
  const d = drafts[c.id];
  if (!d) return;
  let mapping: Record<string, any> = {};
  try {
    mapping = d.mappingText.trim() ? JSON.parse(d.mappingText) : {};
  } catch {
    flash("字段映射不是合法 JSON，先修好再保存", true);
    return;
  }
  const target: Record<string, any> = { ...(c.target || {}) };
  if (c.id === "local-file") target.dir = d.targetUrl.trim();
  else target.url = d.targetUrl.trim();
  const payload: any = {
    id: c.id,
    enabled: d.enabled,
    target,
    mapping,
    actions: d.actions,
    queue: { ...(c.queue || {}), maxAttempts: Math.max(1, Number(d.maxAttempts) || 3), staleMs: Math.max(1000, Number(d.staleMs) || 900000) },
  };
  if (d.secret) payload.secret = d.secret;
  if (d.clearSecret) payload.clearSecret = true;
  await saveConnector(payload);
  d.secret = "";
  d.clearSecret = false;
}

function fmtTime(v?: number) {
  if (!v) return "—";
  const d = new Date(v);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
</script>

<template>
  <div class="hd">连接器 <b>{{ list.length }}</b></div>
  <div v-if="!list.length" class="empty">— 没有连接器（检查 server/connectors/） —</div>
  <template v-for="c in list" :key="c.id">
  <div v-if="drafts[c.id]" class="card connector-card">
    <div class="row" style="gap:10px; align-items:center">
      <span class="sdot" :class="{ on: c.enabled, err: c.health?.lastError }"></span>
      <b>{{ c.label }}</b>
      <span class="badge">{{ c.kind }}</span>
      <span class="pmeta">{{ c.id }}</span>
      <span class="sp"></span>
      <label class="confirm" style="display:inline-flex;align-items:center;gap:6px">
        <input v-model="drafts[c.id].enabled" type="checkbox" />
        <span>启用</span>
      </label>
    </div>

    <div class="pmeta" style="margin-top:8px">
      最近成功 {{ fmtTime(c.health?.lastOkAt) }} · 积压 {{ c.queueStats?.pending || 0 }} · 失败 {{ c.queueStats?.failed || 0 }} · 运行中 {{ c.queueStats?.running || 0 }}
      <span v-if="c.health?.lastError" style="color:#e08a8a"> · {{ c.health.lastError.slice(0, 120) }}</span>
    </div>

    <div class="row" style="margin-top:12px; gap:10px; align-items:center">
      <span class="pmeta">{{ c.id === "local-file" ? "台账目录" : "目标地址" }}</span>
      <input type="text" style="flex:1" v-model="drafts[c.id].targetUrl" :placeholder="c.id === 'local-file' ? 'data/ledger' : 'https://…'" />
    </div>

    <div class="acts" style="margin-top:10px">
      <span class="pmeta">动作</span>
      <button
        v-for="a in c.capabilities || []"
        :key="a"
        class="act"
        :class="{ on: drafts[c.id].actions.includes(a) }"
        @click="toggleAction(c, a)">
        {{ a }}
      </button>
    </div>

    <details style="margin-top:12px">
      <summary class="pmeta" style="cursor:pointer">高级：字段映射 / 重试 / 密钥</summary>
      <div class="hint" style="margin-top:10px">字段映射（JSON；tencent-wb 用 title/status/note/priority）</div>
      <textarea v-model="drafts[c.id].mappingText" rows="5" spellcheck="false" style="font-family:var(--mono);font-size:12px"></textarea>
      <div class="row" style="margin-top:10px; gap:10px; align-items:center">
        <span class="pmeta">最多重试</span>
        <input type="number" min="1" max="10" class="num" v-model.number="drafts[c.id].maxAttempts" />
        <span class="pmeta">卡死判定（ms）</span>
        <input type="number" min="1000" step="60000" class="num" v-model.number="drafts[c.id].staleMs" />
      </div>
      <div v-if="(c.secrets || []).includes('token')" class="row" style="margin-top:10px; gap:10px; align-items:center">
        <span class="pmeta">token</span>
        <input
          type="password"
          style="flex:1"
          v-model="drafts[c.id].secret"
          :placeholder="c.hasSecret ? '已配置（留空保持不变）' : '未配置'"
        />
        <label v-if="c.hasSecret" class="pmeta" style="display:inline-flex;align-items:center;gap:6px">
          <input type="checkbox" v-model="drafts[c.id].clearSecret" /> 清除
        </label>
      </div>
    </details>

    <div class="acts" style="margin-top:14px">
      <button class="act" @click="save(c)">保存</button>
      <button class="act" @click="testConnector(c.id)">发测试行</button>
      <button class="act" @click="replayConnector(c.id)">重放失败</button>
      <span class="sp"></span>
      <span class="pmeta">密钥只写 data/secrets.json，不返回前端</span>
    </div>
  </div>
  </template>
</template>
