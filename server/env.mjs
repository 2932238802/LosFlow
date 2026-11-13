// env.mjs -- 派单执行环境判定（wsl / windows）。
//
// 规则必须与 agent/_paths.ps1 的 Resolve-DsEnv 逐字一致，改这里就同步改那边。
//
//   显式 env = "wsl" / "windows"        → 以显式为准，不再猜
//   空字符串                            → defaultEnv（默认 wsl，保持老任务行为）
//   以 \\ 或 // 开头（UNC）             → windows
//   X:\ 或 X:/ 开头                     → windows
//   以 ~/ 或 / 开头                     → wsl
//   其他相对路径                        → windows（相对路径只可能相对本机 cwd）
//
// 两个约定（写死在代码里，不要"修"）：
//   1. /mnt/d/... 判为 wsl 是故意的：环境跟随「路径形态」，不跟随「磁盘在哪」。
//      要 Windows 跑 D 盘项目，就在项目里登记 Windows 路径 D:\...。
//   2. 判定结果在派单时固化写入任务和台账（task.env / ledger env），之后改路径不追溯，
//      避免同一条任务前后环境漂移。

export const ENVS = ["wsl", "windows"];

export function isEnv(v) {
  return v === "wsl" || v === "windows";
}

export function resolveEnv(path, explicit, defaultEnv = "wsl") {
  const ex = String(explicit || "").trim().toLowerCase();
  if (isEnv(ex)) return ex;

  const p = String(path ?? "").trim();
  if (!p) return isEnv(defaultEnv) ? defaultEnv : "wsl";

  // UNC：\\NAS\share 或 //NAS/share。必须放在「/ 开头」之前判断。
  if (p.startsWith("\\\\") || p.startsWith("//")) return "windows";
  // 盘符：D:\ 或 D:/
  if (/^[A-Za-z]:[\\/]/.test(p)) return "windows";
  // POSIX 绝对路径 / 家目录（含 /mnt/d/...，见上面的约定）
  if (p.startsWith("/") || p.startsWith("~/")) return "wsl";
  // 其余（.\sub、sub\dir）按本机 Windows 处理
  return "windows";
}

// 展示用：前端角标统一文案
export function envLabel(env) {
  return env === "windows" ? "Windows" : "WSL2";
}
