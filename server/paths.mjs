// paths.mjs -- LosFlow 的路径解析。默认全部落在仓库内，机器相关的用环境变量覆盖。
//
// 约定：
//   data/        运行时数据（任务表、池子、台账、runs 归档、streams 回放归档）—— 不进 git
//   data/streams 派单结束后的 stream-json 原始回放（默认保留 7 天，随 /api/maintenance/purge 清理）
//   web/dist     前端构建产物，由本服务托管
//   server/      后端源码（含 scan-terminals.sh）
//   agent/       Windows 侧 PowerShell 派单脚本 + wb-bridge
//   .tmp/        临时文件（派单正文等）
//
// 环境变量（可选）：
//   LOSFLOW_DATA        数据目录，默认 <repo>/data
//   LOSFLOW_TEMP        临时目录，默认 <repo>/.tmp
//   LOSFLOW_WSL_DISTRO  WSL 发行版，默认 Ubuntu-26.04
//   LOSFLOW_WSL_REPO    WSL 里的默认工作仓库，默认 ~/LosAngelous/Vesta
//   LOSFLOW_DEFAULT_ENV 空 repo 时的默认环境（wsl / windows），默认 wsl
//   LOSFLOW_PORT        端口，默认 8899
//   LOSFLOW_NODE        node 可执行文件，默认 node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..");
export const SERVER_DIR = HERE;

const DEFAULTS = {
  root: ROOT,
  serverDir: SERVER_DIR,
  dataDir: join(ROOT, "data"),
  webDir: join(ROOT, "web"),
  webDist: join(ROOT, "web", "dist"),
  agentDir: join(ROOT, "agent"),
  tempDir: join(ROOT, ".tmp"),
  wslDistro: "Ubuntu-26.04",
  wslRepo: "~/LosAngelous/Vesta",
  // 派单执行环境：空 repo 时走哪个环境（保持现状 = wsl）
  defaultEnv: "wsl",
  // Windows 侧 Claude Code：空则自动解析（见 agent/runners/run-windows.ps1）
  windowsClaudeCmd: "",
  windowsClaudeArgs: [],
  // 注入给 Windows 子进程的环境变量（建议放 JZ 网关三件套；key 只写进 losflow.config.json）
  windowsClaudeEnv: {},
  claudeTimeoutSec: 600,
  // 实时审批（--permission-prompt-tool -> agent/approval-mcp.py）；false 退回「跑完再问」
  liveApprove: true,
  approvalTimeoutSec: 50,
  // Windows 桌面提醒：新请求入队即弹 NotifyIcon 气球 + 声音；20s 未处理再响一次
  notify: { enabled: true, mode: "auto", sound: true, minIntervalMs: 8000, repeatAfterMs: 20000 },
  dashboardPort: 8899,
  nodeExe: process.env.LOSFLOW_NODE || "node",
};

function env(name, fallback) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : fallback;
}

// 仓库根的 losflow.config.json 覆盖默认值（机器相关，不进 git）
function fileConfig() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "losflow.config.json"), "utf8"));
  } catch {
    return {};
  }
}

export function loadPaths() {
  const out = { ...DEFAULTS };
  const cfg = fileConfig();
  for (const [k, v] of Object.entries(cfg)) {
    if (v !== null && v !== undefined && v !== "") out[k] = v;
  }
  out.dataDir = env("LOSFLOW_DATA", out.dataDir);
  out.tempDir = env("LOSFLOW_TEMP", out.tempDir);
  out.wslDistro = env("LOSFLOW_WSL_DISTRO", out.wslDistro);
  out.wslRepo = env("LOSFLOW_WSL_REPO", out.wslRepo);
  out.defaultEnv = env("LOSFLOW_DEFAULT_ENV", out.defaultEnv);
  if (out.defaultEnv !== "wsl" && out.defaultEnv !== "windows") out.defaultEnv = "wsl";
  out.claudeTimeoutSec = Number(out.claudeTimeoutSec) || 600;
  out.approvalTimeoutSec = Math.max(5, Math.min(55, Number(out.approvalTimeoutSec) || 50));
  out.liveApprove = out.liveApprove !== false && out.liveApprove !== "false";
  // notify 是对象：配置里只写一半时用默认值补齐，别让整块被替换成 undefined
  const nd = DEFAULTS.notify;
  const nc = out.notify && typeof out.notify === "object" ? out.notify : {};
  out.notify = {
    enabled: nc.enabled !== false && nc.enabled !== "false",
    mode: nc.mode || nd.mode,
    sound: nc.sound !== false && nc.sound !== "false",
    minIntervalMs: Number(nc.minIntervalMs) >= 0 ? Number(nc.minIntervalMs) : nd.minIntervalMs,
    repeatAfterMs: Number(nc.repeatAfterMs) >= 0 ? Number(nc.repeatAfterMs) : nd.repeatAfterMs,
  };
  if (env("LOSFLOW_NOTIFY", "") === "0") out.notify.enabled = false;
  out.dashboardPort = Number(env("LOSFLOW_PORT", out.dashboardPort)) || 8899;
  // stream 回放归档跟着 dataDir 走（测试用 LOSFLOW_DATA 时不会写进真实 data/）
  out.streamsDir = env("LOSFLOW_STREAMS", join(out.dataDir, "streams"));
  // 每次派单的运行态（per-run 状态文件 + Windows runner 的流/回执临时产物）
  // 显式配置 / 环境变量优先，否则跟着 dataDir 走（测试换 data 时不会写到真实目录）
  out.runstateDir = env("LOSFLOW_RUNSTATE", cfg.runstateDir || join(out.dataDir, "runstate"));
  // 兼容旧字段名（原来叫 progressDir / toolsDir，现在统一指向 data）
  out.progressDir = out.dataDir;
  out.toolsDir = out.dataDir;
  return out;
}
