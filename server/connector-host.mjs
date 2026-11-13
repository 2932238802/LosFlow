// connector-host.mjs -- 连接器注册表 / 配置 / 健康（13 号方案）。
//
// 目录：server/connectors/<id>/connector.json + index.mjs
// 配置：data/connectors.json（可热改，不进 git；迁移/备份随 data/）
// 密钥：data/secrets.json（只给连接器用，不进 /api/config /api/state / 日志）
//
// 形态：
//   executor -- WorkBuddy 等外部 agent 通过 MCP 取活执行（tencent-wb）
//   direct   -- LosFlow server 自己执行（local-file / http-webhook）
//
// 安全边界：只扫描 server/connectors/ 下的 manifest；只 import 已启用连接器的
// index.mjs；不做 npm 安装、不执行 package.json 脚本。

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

let PATHS = null;
const manifests = new Map(); // id -> { ...manifest, dir, modulePath }
const configs = new Map(); // id -> config
const instances = new Map(); // id -> { manifest, config, impl }
const health = new Map(); // id -> { lastOkAt, lastError, lastErrorAt, lastAction, lastJobId }

const connectorsDir = () => (PATHS && PATHS.connectorsDir) || join(PATHS.root, "server", "connectors");
const configFile = () => (PATHS && PATHS.connectorsFile) || join(PATHS.dataDir, "connectors.json");
const secretsFile = () => (PATHS && PATHS.secretsFile) || join(PATHS.dataDir, "secrets.json");
const logFile = (id) => join(PATHS.dataDir, "connectors", `${id}.log`);

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
    try {
      renameSync(tmp, file);
    } catch {
      writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
    }
  } catch (e) {
    try { console.error("[connectors] write failed", file, e.message); } catch { /* ignore */ }
  }
}

function isObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// 深合并：对象递归，数组/标量直接覆盖
function merge(base, patch) {
  if (!isObject(base) || !isObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

function normalizeConfig(id, raw) {
  const m = manifests.get(id);
  const def = (m && m.defaultConfig) || {};
  const cfg = merge(def, isObject(raw) ? raw : {});
  if (typeof cfg.enabled !== "boolean") cfg.enabled = !!cfg.enabled;
  if (!Array.isArray(cfg.actions)) cfg.actions = [...(m?.capabilities || [])];
  cfg.queue = merge({ maxAttempts: 3, staleMs: 15 * 60 * 1000 }, cfg.queue || {});
  return cfg;
}

function loadManifests() {
  manifests.clear();
  const dir = connectorsDir();
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return;
  }
  for (const ent of entries) {
    const root = resolve(dir, ent.name);
    const file = join(root, "connector.json");
    const manifest = readJson(file, null);
    if (!manifest || manifest.manifestVersion !== 1) continue;
    if (!manifest.id || !["executor", "direct"].includes(manifest.kind)) continue;
    const modulePath = join(root, "index.mjs");
    if (!existsSync(modulePath)) continue;
    manifests.set(String(manifest.id), { ...manifest, id: String(manifest.id), dir: root, modulePath });
  }
}

function loadConfigs() {
  const saved = readJson(configFile(), []);
  const byId = new Map((Array.isArray(saved) ? saved : []).map((x) => [String(x.id || ""), x]));
  configs.clear();
  for (const id of manifests.keys()) {
    configs.set(id, normalizeConfig(id, byId.get(id)));
  }
}

async function reload() {
  instances.clear();
  for (const [id, manifest] of manifests) {
    const config = configs.get(id) || normalizeConfig(id, {});
    configs.set(id, config);
    if (!config.enabled) continue;
    try {
      const mod = await import(pathToFileURL(manifest.modulePath).href);
      const factory = mod && (mod.default || mod);
      if (!factory || typeof factory.apply !== "function") throw new Error("index.mjs 需要 export default { apply(host) }");
      const impl = factory.apply({ config, paths: PATHS, log: makeLogger(id), secret: getSecret(id) });
      instances.set(id, { manifest, config, impl: impl || {} });
    } catch (e) {
      const h = health.get(id) || {};
      health.set(id, { ...h, lastError: `加载失败：${e.message}`, lastErrorAt: Date.now() });
      try { console.error(`[connectors] ${id} load failed: ${e.message}`); } catch { /* ignore */ }
    }
  }
}

export function makeLogger(id) {
  return {
    info: (m) => writeLog(id, "info", m),
    warn: (m) => writeLog(id, "warn", m),
    error: (m) => writeLog(id, "error", m),
  };
}

function writeLog(id, level, msg) {
  try {
    const file = logFile(id);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${level} ${String(msg).replace(/\n/g, " ").slice(0, 2000)}\n`, "utf8");
  } catch {
    /* 日志失败不影响主流程 */
  }
}

export async function initConnectors(paths) {
  PATHS = paths;
  loadManifests();
  loadConfigs();
  // 首次启动把默认配置落盘，方便用户直接看 / 改 / 备份
  if (!existsSync(configFile())) {
    writeJson(configFile(), [...configs.entries()].map(([id, cfg]) => ({ id, ...cfg })));
  }
  await reload();
}

export async function reloadConnectors() {
  loadManifests();
  loadConfigs();
  await reload();
}

export function getSecret(id) {
  const all = readJson(secretsFile(), {});
  const v = all && all[String(id)];
  return typeof v === "string" ? v : "";
}

export function hasSecret(id) {
  return !!getSecret(id);
}

export function setSecret(id, value) {
  const all = readJson(secretsFile(), {});
  if (value === undefined || value === null) return;
  if (String(value) === "") delete all[String(id)];
  else all[String(id)] = String(value);
  writeJson(secretsFile(), all);
}

function publicConfig(id) {
  const m = manifests.get(id);
  const cfg = configs.get(id) || {};
  const h = health.get(id) || {};
  return {
    id,
    kind: m?.kind || "",
    version: m?.version || "",
    label: (m?.label && (m.label.zh || m.label.en)) || id,
    labelI18n: m?.label || {},
    capabilities: m?.capabilities || [],
    configSchema: m?.configSchema || null,
    secrets: m?.secrets || [],
    enabled: !!cfg.enabled,
    target: cfg.target || {},
    mapping: cfg.mapping || {},
    actions: cfg.actions || [],
    match: cfg.match || m?.match || {},
    queue: cfg.queue || {},
    hasSecret: hasSecret(id),
    health: {
      lastOkAt: h.lastOkAt || 0,
      lastErrorAt: h.lastErrorAt || 0,
      lastError: h.lastError || "",
      lastAction: h.lastAction || "",
      lastJobId: h.lastJobId || "",
    },
  };
}

export function listConnectors() {
  return [...manifests.keys()]
    .map(publicConfig)
    .sort((a, b) => (a.kind === "executor" ? 0 : 1) - (b.kind === "executor" ? 0 : 1) || a.id.localeCompare(b.id));
}

export function getConnector(id) {
  return instances.get(String(id)) || null;
}

export function getConfig(id) {
  return configs.get(String(id)) || null;
}

export function enabledConnectors() {
  return [...instances.entries()].map(([id, x]) => ({ id, ...x }));
}

export function executors() {
  return enabledConnectors().filter((x) => x.manifest.kind === "executor");
}

export function enqueueTargets(action) {
  return enabledConnectors().filter((x) => {
    const actions = x.config.actions || x.manifest.capabilities || [];
    return actions.includes(action) && (x.manifest.kind === "executor" || typeof x.impl.write === "function");
  });
}

export function describe(id, action, payload) {
  const ins = instances.get(String(id));
  if (!ins || typeof ins.impl.describe !== "function") return "";
  return String(ins.impl.describe(action, payload) || "");
}

// 判定一段文字是不是「文档活」。即使连接器被关闭，也用 manifest 的 match 兜底，
// 避免把腾讯文档指令当普通任务派给 Claude Code。
export function matchDocInstruction(text) {
  const s = String(text || "");
  if (!s) return false;
  for (const ins of instances.values()) {
    if (ins.impl && typeof ins.impl.match === "function") {
      try {
        if (ins.impl.match(s)) return true;
      } catch { /* ignore */ }
    }
  }
  for (const m of manifests.values()) {
    const cfg = configs.get(m.id) || {};
    const rules = cfg.match || m.match || {};
    for (const p of rules.urlPatterns || []) {
      try { if (new RegExp(p, "i").test(s) && /(追加|新增|写入|补写|整理|归档|移(?:到|入|出|至))/.test(s)) return true; } catch { /* ignore */ }
    }
    for (const p of rules.keywords || []) {
      try { if (new RegExp(p, "i").test(s)) return true; } catch { /* ignore */ }
    }
  }
  return false;
}

export function noteHealth(id, { ok, error = "", action = "", jobId = "" } = {}) {
  const key = String(id);
  const h = health.get(key) || {};
  const now = Date.now();
  health.set(key, ok
    ? { ...h, lastOkAt: now, lastError: "", lastAction: action || h.lastAction || "", lastJobId: jobId || h.lastJobId || "" }
    : { ...h, lastErrorAt: now, lastError: String(error || "unknown"), lastAction: action || h.lastAction || "", lastJobId: jobId || h.lastJobId || "" });
}

export function healthOf(id) {
  const h = health.get(String(id)) || {};
  return {
    lastOkAt: h.lastOkAt || 0,
    lastErrorAt: h.lastErrorAt || 0,
    lastError: h.lastError || "",
    lastAction: h.lastAction || "",
    lastJobId: h.lastJobId || "",
  };
}

export async function saveConnector(input = {}) {
  const id = String(input.id || "");
  if (!id || !manifests.has(id)) throw new Error("未知连接器: " + id);
  const cur = configs.get(id) || normalizeConfig(id, {});
  const patch = {};
  for (const k of ["enabled", "target", "mapping", "actions", "match", "queue"]) {
    if (input[k] !== undefined) patch[k] = input[k];
  }
  const next = normalizeConfig(id, merge(cur, patch));
  configs.set(id, next);
  if (input.secret !== undefined) setSecret(id, input.secret);
  if (input.clearSecret) setSecret(id, "");
  // 持久化所有连接器配置（含默认值），方便热改 / 备份
  writeJson(configFile(), [...configs.entries()].map(([cid, cfg]) => ({ id: cid, ...cfg })));
  await reload();
  return publicConfig(id);
}

export function connectorSummary() {
  return listConnectors();
}
