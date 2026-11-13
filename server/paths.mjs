// paths.mjs -- LosFlow 的路径解析。默认全部落在仓库内，机器相关的用环境变量覆盖。
//
// 约定：
//   data/        运行时数据（任务表、池子、台账、runs 归档、审批队列）—— 不进 git
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
  out.dashboardPort = Number(env("LOSFLOW_PORT", out.dashboardPort)) || 8899;
  // 兼容旧字段名（原来叫 progressDir / toolsDir，现在统一指向 data）
  out.progressDir = out.dataDir;
  out.toolsDir = out.dataDir;
  return out;
}
