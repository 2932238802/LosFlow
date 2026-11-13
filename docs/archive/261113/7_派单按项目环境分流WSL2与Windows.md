# 7 · 派单按项目环境分流：WSL2 项目走 WSL2 的 Claude Code，Windows 项目走 Windows 的 Claude Code

| 项 | 内容 |
| --- | --- |
| 编号 | 7 |
| 日期 | 2026-11-13 |
| 项目 | LosFlow（`D:\PROJECT\LosFlow`） |
| 类型 | 后端派单架构 / 环境适配 / 配置 / 少量前端 |
| 状态 | 方案待确认（未实施） |
| 提出 | 杰哥（「现在是只能启动 WSL2 的 Claude 么？我想要增加适配性：在 WSL2 的项目调用 WSL2 的 Claude Code，如果是 Windows 的调用 Windows 的 Claude Code，互不干涉」） |
| 涉及文件 | `agent/claude-dispatch.ps1`、`agent/_paths.ps1`、`server/paths.mjs`、`server/dispatch.mjs`、`server/events.mjs`、`server/server.mjs`、`server/scan-terminals.sh`、`data/projects.json`、`web/src/types.ts`、`web/src/store/useProjects.ts`、`web/src/views/SettingsView.vue`、`web/src/components/TaskCard.vue`、`web/src/components/TerminalCard.vue`、`losflow.config.example.json`、`docs/api.md`、`README.md` |

## 一句话结论

**现在确实只能跑 WSL2 的 Claude Code。** 派单脚本把「repo 校验、bash 脚本、`start_claude_code_jz`、回执 JSON、事件流、pid、终止」全部绑死在 `wsl.exe -d <distro>` 这一条链路上（`agent/claude-dispatch.ps1:276-319`）；即使把 `D:\...` 填进任务 `repo`，也会在 WSL 里 `cd` 失败（退出码 90）或被当成相对路径。

适配不是「加一个 if」，而是把**执行环境（env）提成派单的一等字段**：先判定项目属于 `wsl` 还是 `windows`，再由环境专属 runner 执行，最后回到同一条回执 / 台账 / 流 / 终止 / 扫描管线。两边各用各的 CLI、配置、会话、进程和临时文件，互不读写。

Windows 侧的 Claude Code 本机已可用：`claude 2.1.323`，真实可执行文件在 `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`（另有原生安装副本 `~\.claude\bin\claude.exe`），用户级配置在 `~/.claude.json` 与 `~/.claude`（前者的 `projects` 已登记 `D:/PROJECT/Hector`、`D:/PROJECT/LosFlow`）。

而且 Windows 侧已经有一套**同网关**的启动器：`losclaude` → `C:\Users\admin\.local\bin\losclaude.cmd` → `D:\Desktop\Claude Code\claude-jz.ps1`，它在当前目录注入 `ANTHROPIC_BASE_URL=http://one-api.server22.jz`、`ANTHROPIC_MODEL=deepseek-v4-flash` 和 key，与 WSL 的 `start_claude_code_jz` 是同一套账。所以「Windows 的 Claude Code」不是订阅孤岛，适配后两边成本口径天然一致。

所以这不是「装一个」的问题，是「派单链路只认 WSL」的问题。

## 现状核对（2026-11-13 逐处）

| # | 位置 | 实际行为 | 对 Windows 项目的后果 |
| --- | --- | --- | --- |
| 1 | `agent/claude-dispatch.ps1:3` | 脚本自述「Dispatch one task to Claude Code inside WSL2」 | 设计上就没打算支持 Windows |
| 2 | `agent/claude-dispatch.ps1:110-113` | 缺省 `-OutDir/-Distro/-Repo` 一律取 `_paths.ps1` 的 WSL 默认值 | 不传 repo 时永远落到 `~/LosAngelous/Vesta` |
| 3 | `agent/claude-dispatch.ps1:241-244` | 脚本 / 回执 / stderr / 流全部写 `/tmp/cc-<id>.*` | Windows 侧没有 `/tmp` |
| 4 | `agent/claude-dispatch.ps1:273-283` | 生成 bash 脚本：`cd "$repo" \|\| exit 90` + `timeout ... start_claude_code_jz` | Windows 路径在 bash 里不存在；Windows 也没有 `start_claude_code_jz` |
| 5 | `agent/claude-dispatch.ps1:299-301` | 通过 `\\wsl.localhost\<distro>\tmp` 落脚本 | 整条链路依赖 WSL 共享可写 |
| 6 | `agent/claude-dispatch.ps1:319` | 执行只用 `wsl.exe -d <Distro> -- bash <script>` | 没有「本机直接跑」的分支 |
| 7 | `agent/claude-dispatch.ps1:327-344` | 回执 JSON / stderr 从 UNC 的 `/tmp` 读回 | Windows 运行拿不到回执 |
| 8 | `server/dispatch.mjs:60-62` | 没有 repo 就补 `PATHS.wslRepo`，并**总是**传 `-Distro` | Windows 项目也会被塞进 WSL |
| 9 | `server/dispatch.mjs:113` | `archiveStream` 固定从 `\\wsl.localhost\<distro>\tmp\cc-<id>.stream.jsonl` 复制 | Windows 流不会归档，历史会话空白 |
| 10 | `server/dispatch.mjs:127-160` | 「终止」固定 `wsl.exe ... kill` 读 `/tmp/cc-<id>.pid` | Windows 进程杀不到 |
| 11 | `server/events.mjs:19,110,182,250` | 事件流 / 回放路径全部硬编码 `\\wsl.localhost\<distro>\tmp` | Windows 会话的实时流、回放都读不到 |
| 12 | `server/server.mjs:279-281,323-327,340-362` | 「哪些终端在跑」靠 WSL 里的 `/tmp/cc-*.pid` + `scan-terminals.sh`，清理也走 WSL | Windows 运行不会出现在「终端」页，也不会被清理 |
| 13 | `server/paths.mjs:35-36,63-64` | 只有 `wslDistro` / `wslRepo`，没有 Windows runner / 默认环境配置 | 没有地方声明「这台机器怎么跑 Windows」 |
| 14 | `data/projects.json` | 两条项目都是 POSIX 路径（`~/LosAngelous/Vesta`、`/home/losangelous/LosAngelous/JZ`），没有 `env` 字段 | 即使加入 Windows 项目，也没有显式归属 |
| 15 | `web/src/types.ts:66` | `Project = { id; name; path }` | 前端无法展示 / 选择环境 |
| 16 | `README.md:61-62` | 依赖表写死「WSL2（默认 Ubuntu-26.04）」「`/usr/bin/start_claude_code_jz`」 | 文档口径也是 WSL-only |
| 17 | `server/server.mjs:112`（`optimizeViaGateway`） | 从 WSL 启动器里 `grep '^export ANTHROPIC_'` 取网关地址与 key | WSL 停掉时，提示词优化 / 拆分 / 文档生成也会跟着失效（当前就是 WSL 单点） |

## 目标与非目标

**目标**

1. 项目维度自动判定环境：POSIX 路径 → WSL，Windows 盘符 / UNC 路径 → Windows；允许项目或任务显式覆盖。
2. 两种环境**功能等价**：read / write / 续接 / 终止 / 实时流 / 回放 / 台账 / 成本 / 权限拒绝与审批队列，行为一致。
3. **互不干涉**：各用各的 CLI 与登录态、各写各的临时目录、各记各的 pid 与会话；一边停掉不影响另一边，同名任务在两边互不去重。
4. **失败前置**：环境与路径不匹配时，在花钱之前报 `preflight` 错误，不写 `running.json`、不产生半截台账。
5. 老数据零迁移：没有 `env` 的旧任务 / 旧台账 / 旧项目，一律按 `wsl` 解读，现有行为不变。

**非目标**

- 不做 SSH / 远程机器 dispatcher（只区分本机 WSL 与 Windows）。
- 不跨环境续接会话（WSL 的 `session_id` 不能在 Windows 续，反之亦然）。
- 不把 WSL 的 `settings.json`、MCP、权限规则同步到 Windows；两边配置各自维护。
- 不在这一版统一两边的计费口径（见「风险与待确认」第 1 条）。

## 设计

### 1. 环境判定：唯一入口，前后端同一套规则

新增一个纯函数 `resolveEnv(path, explicit, defaultEnv)`，服务端（`server/env.mjs`）和 PowerShell（`agent/_paths.ps1`）各实现一份，规则必须逐字一致：

| 输入 | 判定 | 例子 |
| --- | --- | --- |
| 显式 `env = "wsl"` / `"windows"` | 以显式为准，不再猜 | 项目手动标成 windows |
| 以 `~/` 或 `/` 开头 | `wsl` | `~/LosAngelous/Vesta`、`/home/losangelous/LosAngelous/JZ`、`/mnt/d/PROJECT/Foo` |
| `X:\` 或 `X:/` 开头 | `windows` | `D:\PROJECT\Hector` |
| 以 `\\` 开头（UNC） | `windows` | `\\NAS\share\proj`（能否 `cd` 由 preflight 验） |
| 空字符串 | `defaultEnv`（默认 `wsl`，保持现状） | 旧任务 `repo: ""` |
| 其他相对路径 | `windows`（相对路径只可能相对本机 cwd） | `.\sub` |

两个约定要写进代码注释，避免以后反复：

- `/mnt/d/...` 判为 `wsl` 是**故意的**：环境跟随「路径形态」，不跟随「磁盘在哪」。要 Windows 跑 `D` 盘项目，就在项目里登记 Windows 路径 `D:\...`。
- 判定结果在**派单时固化**写入任务和台账（`task.env` / ledger `env`），之后改路径不追溯，避免「同一条任务前后环境漂移」。

### 2. runner 拆分：执行不同，其余共用

`claude-dispatch.ps1` 继续做「编排层」：去重、日预算、会话续接解析、allowlist、审批队列、回执解析、台账、`running.json`。执行层抽成两个 runner，输入同一份 run context，输出同一份结果：

```
run context: { id, env, repo, mode, allow, resume, model, mcp, timeoutSec, maxBudget, outDir }
runner 返回: { rc, jsonPath, errPath, streamPath, pid, env, claudeVersion, startedAt }
```

| 文件 | 职责 |
| --- | --- |
| `agent/runners/run-wsl.ps1` | 现有 WSL 逻辑原样迁入：`/tmp/cc-<id>.sh` → `wsl.exe -d` |
| `agent/runners/run-windows.ps1` | 新增：本机 `claude` 直跑，artifacts 落 `$OutDir\runstate` |
| `agent/runners/_common.ps1` | 参数引用拼接 / 版本探测 / runstate 写入，两个 runner 共用 |

这样「Windows 回执解析、审批、去重」不需要各写一份，也不会出现两边字段慢慢漂移。

### 3. WSL runner（语义不变，只加前置校验）

保持现在的行为，另外补 preflight：

1. `wsl.exe -l -q` 能列出 `$Distro`；
2. `/usr/bin/start_claude_code_jz` 存在且可执行；
3. `repo` 在 WSL 里存在（`test -d`）；
4. `\\wsl.localhost\<Distro>\tmp` 可写（脚本落盘前）；
5. 回执字段补 `env = "wsl"`。

任何一条不满足，返回 `rc = 90`、`status = "preflight"`，不写台账、不动 `running.json`。

### 4. Windows runner（新增）

```powershell
# 伪代码，实际参数按 dispatch 的 allow / mode / resume 拼
$exe = Resolve-ClaudeExe          # 见下
Push-Location -LiteralPath $repo
# 任务正文走 stdin；argString 用严格 MSVC 引号规则拼，避免 Start-Process 按空格粗暴拆参数
$p = Start-Process -FilePath $exe -ArgumentList $argString -NoNewWindow -PassThru `
      -RedirectStandardInput $taskFile `
      -RedirectStandardOutput $outFile -RedirectStandardError $errFile
```

要点：

- **可执行文件解析顺序**：`-windowsClaudeCmd` 显式配置 → `Get-Command claude.exe` → `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe` → `~\.claude\bin\claude.exe` → `claude.cmd`（最后才用，且要 aware `%*` 转发对多行/引号不友好）。建议默认走 `.exe`，绕开 cmd 的引号规则。
- **任务正文不要拼进命令行**：沿用现有 `-TaskFile`，Windows runner 用 stdin 喂给 `claude -p`（`Get-Content -Raw task.md | & $exe -p ...`）。这是本方案唯一需要实测确认的 CLI 行为；若不支持，再退回严格 MSVC 引号拼装，并用「含中文 / 双引号 / 换行」的任务各测一遍。
- **工作目录**：`Push-Location -LiteralPath $repo`，失败即 `preflight`（对应 WSL 的 `exit 90`）。
- **输出**：`--output-format json` 或 `stream-json`，stdout / stderr 分开落文件（沿用「stderr 单独文件，避免错误混进 stdout 破坏 JSON 解析」这条既有教训）。
- **pid 与终止**：进程自身 `$p.Id` 写入 runstate；终止用 `Stop-Process -Id <pid> -Force`（必要时 `taskkill /T /F /PID` 带走子进程）。
- **认证与环境隔离**：Windows 侧显式注入 JZ 网关三件套 `ANTHROPIC_BASE_URL=http://one-api.server22.jz`、`ANTHROPIC_MODEL=deepseek-v4-flash`、`ANTHROPIC_API_KEY`（key 只放 gitignored 的 `losflow.config.json`，仓库和文档里一律用占位符）。子进程只带这一组变量，**不继承**任何来自 WSL 的 `ANTHROPIC_*`。**不要直接调用 `claude-jz.ps1`**：它会弹文件夹选择框、失败时 `Read-Host` 等人按键，无人值守派单会卡死；runner 复制它的环境设置，直接调 `.exe`。
- **版本门槛**：`claude --version` 解析，低于 `2.1.0` 直接 preflight 失败（`--strict-mcp-config`、`--max-budget-usd`、stream-json 都需要较新版本；本机实测 2.1.323 全部支持）。

### 5. 统一「运行态」：不要再用全局 `running.json` 猜

现在 `running.json` 只记最后一条，是「终止」和「终端页」串台的根。引入 per-run 状态文件：

```
data/runstate/<runId>.json
{
  "id": "20261113-...", "taskId": "8", "env": "windows",
  "repo": "D:\\PROJECT\\Hector", "stream": "D:\\PROJECT\\LosFlow\\data\\runstate\\<id>.stream.jsonl",
  "pid": 12345, "startedAt": "2026-11-13 19:20:00", "claudeVersion": "2.1.323"
}
```

- 由编排层在启动前写、结束后删（异常退出由 30 分钟宽限期清理，逻辑复用 `prunePending` 的思路）。
- `stopRun(taskId)` 先按 `taskId` 找 runstate，再按 `env` 选终止方式，不再读全局最后一个。
- 终端扫描：WSL 仍扫 `/tmp/cc-*.pid`；Windows 由 Node 读 `data/runstate/*.json` 并用 `process.kill(pid, 0)` 探活；两边合并后返回 `items[].env`。
- `running.json` 保留一版兼容，但只作为「最后一条」的展示兜底。

### 6. 流与回放的路径解析

`server/events.mjs` 现在有 4 处硬编码 UNC（`:19/:110/:182/:250`）。改成单一解析函数：

```
resolveRunFile(runId):
  1) data/streams/<id>.jsonl                      → source=archive
  2) data/runstate/<id>.json 里的 stream 存在      → source=<env>（运行时）
  3) \\wsl.localhost\<distro>\tmp\cc-<id>.stream.jsonl → source=wsl（旧数据兼容）
  4) missing
```

Windows runner 的 stream 直接写 `data/runstate/<id>.stream.jsonl`，派单结束由 `archiveStream` 复制进 `data/streams/<id>.jsonl` 并删临时文件。这样：

- 实时 SSE 与历史回放共用同一条解析；
- `source` 枚举从 `archive|wsl|missing` 扩成 `archive|wsl|windows|missing`，前端按值显示角标；
- `docs/api.md` 的 `/api/task/raw` 说明同步更新。

### 7. 配置

`losflow.config.json` 增字段（`losflow.config.example.json` 同步）：

```json
{
  "wslDistro": "Ubuntu-26.04",
  "wslRepo": "~/LosAngelous/Vesta",
  "defaultEnv": "wsl",
  "windowsClaudeCmd": "",
  "windowsClaudeArgs": [],
  "windowsClaudeEnv": {},
  "claudeTimeoutSec": 600
}
```

| 字段 | 含义 | 默认 |
| --- | --- | --- |
| `defaultEnv` | 空 repo 时走哪个环境 | `wsl`（保持现状） |
| `windowsClaudeCmd` | Windows 侧可执行文件，空则自动解析 | `""` |
| `windowsClaudeArgs` | 每次追加的参数（如 `--settings`） | `[]` |
| `windowsClaudeEnv` | 注入给子进程的环境变量（默认就是 JZ 网关三件套） | `{}` |

`windowsClaudeEnv` 建议只在 `losflow.config.json` 里写，示例文件（进 git）保持空对象并加注释说明字段名。key 不写文档、不写 README、不写提交信息。若机器上已有 `claude-jz.ps1` / `losclaude`，可以把它里面的 `ANTHROPIC_*` 原样搬进这个字段，**不要**让派单脚本去解析 `claude-jz.ps1`（那是给人用的交互脚本，日后改动会影响无人值守链路）。

`data/projects.json` 每条加 `env`：

```json
[
  { "id": "vesta", "name": "Vesta", "path": "~/LosAngelous/Vesta", "env": "auto" },
  { "id": "p-hector", "name": "Hector", "path": "D:\\PROJECT\\Hector", "env": "auto" }
]
```

`env = "auto"` 时按第 1 节规则判定；显式值只用于「路径形态与运行环境不一致」的少数情况。

### 8. 接口与前端

| 位置 | 改动 |
| --- | --- |
| `server/server.mjs:729` `/api/projects/add` | 接收 `env`（`auto/wsl/windows`），默认 `auto`；返回值带解析后的 `env` |
| `server/server.mjs:822` `/api/task/repo` | 可同时写 `env`；只改 repo 时按 `auto` 重新解析 |
| `server/server.mjs:548` `startDispatch` | 把 `task.repo` 解析出的 `env` 传给 `runDispatch` |
| `server/dispatch.mjs:38` `runDispatch` | 增 `env` 入参，传给 `claude-dispatch.ps1 -Env`；无 repo 时用 `defaultEnv` |
| `/api/state`（`buildState`） | 任务带 `env`（已解析），项目带 `env`，终端 `items[]` 带 `env` |
| `web/src/types.ts:66` | `Project` 加 `env`；`Task` 加 `env`；`TerminalRun` 加 `env` |
| `web/src/views/SettingsView.vue:32-33` | 项目卡显示环境徽标（`WSL2` / `Windows`），新增项目时可选「自动判定」 |
| `web/src/components/TaskCard.vue` | 卡片显示 `env` 小标签（与 owner 徽标同排） |
| `web/src/components/TerminalCard.vue` | 会话头显示 `env`；终止按钮按该会话的 env 路由 |
| 成本展示 | 两边都走 JZ 网关时应回 `total_cost_usd`；若某次回执为 `null`（登录态 / 网关异常），显示「—」而不是 `$0.000` |

### 9. 去重、预算与成本

- 去重 hash 从 `"$Repo|$Mode|$Allow|$Task"` 扩成 `"$Env|$Repo|$Mode|$Allow|$Task"`：同一句话在 WSL 项目和 Windows 项目是两次不同的活，不能互相 `deduped`。
- 两边都用 JZ 网关，`cost_usd` 口径一致，`spendToday` 照旧按数值累加；仅当回执缺金额（`null`）时跳过，并保留 `billing: "unknown"` 便于排查。
- `-MaxCostUsd` 日封顶对两边同样生效；`-MaxBudget` 透传 `--max-budget-usd`，由网关侧结算。

### 10. Preflight 矩阵（全部在花钱之前）

| 条件 | WSL | Windows | 错误输出 |
| --- | --- | --- | --- |
| 环境与路径不匹配 | `cd` 失败 | `Set-Location` 失败 | `status=preflight`, `rc=90`, `error="repo 不存在于 <env>"` |
| Claude 不可用 | 启动器缺失 | `claude` 找不到 / 版本过低 | `status=preflight`, `error="claude not found / version"` |
| 运行器不可达 | distro 不在 / UNC 不可写 | 无 | `status=preflight`, `error="wsl share unreachable"` |
| 认证失败 | 回执 `is_error` | 回执 `is_error` / stderr 含 401 | `status=error`，原文进 `stderr` 字段 |
| 网关不可达 | 回执报错 | 回执报错 | `status=error`，`error` 里带 `one-api.server22.jz` |

preflight 失败必须**不写** `running.json`、**不写**台账、**不产生**审批项，前端提示「环境检查未通过，未产生花费」。

## 实施步骤

### P0：能跑通 Windows 只读派单（最小闭环）

1. `agent/_paths.ps1` + `server/paths.mjs` 增 `defaultEnv`、`windowsClaudeCmd`、`windowsClaudeArgs`、`windowsClaudeEnv`。
2. 新增 `server/env.mjs` 的 `resolveEnv`；`agent/runners/_common.ps1` 实现同规则。
3. `agent/claude-dispatch.ps1` 增 `-Env auto|wsl|windows`；抽出 `agent/runners/run-wsl.ps1`（搬运现有逻辑）与 `run-windows.ps1`；台账 / 输出增 `env`。
4. `server/dispatch.mjs` 透传 `env`；`archiveStream` / `stopRun` 按 env 分支（P0 先只做归档，终止可后置）。
5. `server/events.mjs` 的 `resolveRunFile` 支持 runstate 里的 Windows stream。
6. `data/projects.json` 加 `env`；`/api/projects/add` 接收 `env`。

**P0 验收**：`wsl --shutdown` 之后，派一条 Windows 只读任务（`D:\PROJECT\Hector`），得到 `status=ok` 的回执、`data/streams/<id>.jsonl` 归档、台账 `env=windows`；全程没有 `wsl.exe` 子进程。

### P1：功能对齐

1. Windows 的 write 模式（`--permission-mode acceptEdits`）与 `-Continue` / `-Resume`（按 env+repo 匹配）。
2. `stopRun` 按 env 分支；终端扫描合并 WSL pid + 本地 runstate；`items[].env`。
3. 前端环境徽标、终止路由、成本展示；`docs/api.md` 的 `source` 枚举与说明。
4. 审批队列验证：Windows 的 `permission_denials` 能进 `approvals.json` 并只在 Windows 侧重派。

### P2：收尾与去 WSL 单点

1. `/api/task/optimize`、`/api/task/split`、`/api/task/docs` 等「无 repo」的元调用：改成用同一份网关配置直连 HTTP（Windows 侧可直接 `curl` / `fetch`，不再 `server.mjs:112` 从 WSL 启动器 grep `ANTHROPIC_*`），WSL 停掉也能用。
2. `purgeWslTmp` 扩成「按 env 清理」；`data/runstate` 过期清理。
3. 设置页可编辑 `windowsClaudeCmd` / `defaultEnv`；`README.md` 依赖表改成「WSL2 或 Windows Claude Code（按项目环境二选一）」。

## 兼容与迁移

| 对象 | 旧数据 | 处理 |
| --- | --- | --- |
| 任务 | 无 `env` | 按 `repo` 路径即时解析；`repo` 为空 → `defaultEnv` |
| 项目 | 无 `env` | 视为 `auto` |
| 台账 | 无 `env` 字段 | 读时视为 `wsl`；只影响展示，不影响成本累计 |
| 历史流 | 只在 WSL `/tmp` / `data/streams` | `resolveRunFile` 保留 WSL 回退，旧会话照常打开 |
| 会话续接 | 只有 `sessionId` | 增加 `sessionEnv`；`-Continue` 要求 `repo + env` 同时匹配，否则提示「环境已变，请新开会话」 |

回滚成本低：配置里把 `defaultEnv` 设回 `wsl`、项目 `env` 全设 `auto`，Windows 项目不登记就完全回到现状；两个 runner 是新增文件，不改 WSL 分支。

## 验收标准

1. **WSL 不回归**：原有 Vesta 任务派单后，台账字段与改动前一致（新增 `env=wsl`），回执 `status` 仍为 `ok`，`data/streams` 仍有归档。
2. **Windows 独立可用**：`wsl --shutdown` 状态下派 Windows 任务成功；任务管理器 / 进程链里没有 `wsl.exe`。
3. **并发互不干涉**：同时派一条 WSL、一条 Windows；「终端」页两条都在，`env` 正确；终止 Windows 后 WSL 的 pid 仍活，反之亦然。
4. **不串会话**：Windows 任务 `-Continue` 续的是 Windows 的 `session_id`；把 WSL 的 session id 传给 Windows 会得到明确失败，而不是静默新建。
5. **路径错配前置失败**：`repo=D:\...` 且 `env=wsl` 时，`status=preflight`、`rc=90`、无台账、无花费，错误文案指出「路径与环境不匹配」。
6. **去重不跨环境**：同一段任务文本分别在 WSL 和 Windows 项目各派一次，两次都执行（不出现 `deduped`）。
7. **前端可读**：项目卡 / 任务卡 / 终端卡都能看到环境徽标；回执缺金额时显示「—」而不是 `$0.000`。
8. **流可回放**：Windows 派单结束后，`/api/task/raw` 的 `source=archive`，轮 / 动作数量与运行中 SSE 一致；WSL 旧会话仍 `source=wsl`。
9. **审批可闭环**：Windows 被拒的命令进入审批队列，批准后只重派 Windows 那次，不误派 WSL。
10. **文档一致**：`docs/api.md`、`README.md`、`docs/architecture.md` 不再出现「派单必须走 WSL」的绝对表述。

## 风险与待确认

1. **Windows 侧认证与计费**：已确认 Windows 的 `losclaude` / `claude-jz.ps1` 走的是 JZ 内网网关 `one-api.server22.jz` + `deepseek-v4-flash`，与 WSL 同源，所以**按网关方案落地**，不走订阅 / OAuth 分支。待确认的只剩两件小事：key 是复用 `claude-jz.ps1` 里那把（搬进 `losflow.config.json`），还是单独申请一把只给派单用；以及网关是否需要加访问来源限制（WSL 与 Windows 同时打会不会互相挤占并发）。
2. **MCP 差异**：WSL 侧默认 `--strict-mcp-config` 跳过 MCP，Windows 侧是否也要跳过？若 Windows 项目需要 context7，是否只在 Windows 侧 `-Mcp`？
3. **同一份仓库两边都有**（例如 `D:\PROJECT\Hector` 与 WSL 里另有一份）：按「路径即项目」处理，视为两个独立项目、两套会话；若希望共享 git 历史，需要在项目说明里写清以哪边为准。
4. **元调用仍依赖 WSL**：提示词优化 / 拆分 / 文档生成目前靠 WSL 启动器取网关配置（`server.mjs:112`）。如果经常在 WSL 停止时用驾驶舱，这几个按钮会失效——是否 P0 就抽成独立网关配置？
5. **UNC 项目**：`\\NAS\...` 这类路径 `claude` 能否 `cd`、性能如何，未验证；P1 前先用一条真实路径试探。
6. **硬校验还是软默认**：Windows 项目被误派到 WSL 时，是「preflight 直接拒绝」还是「自动纠正到 Windows」？本文按「显式即可覆盖、默认严格」写；如果杰哥更想要「自动纠正」，改一行即可，但会掩盖配置错误。
7. **`claude -p` 读 stdin**：Windows runner 计划用管道传任务正文，需要实测 `claude -p`（不带 query）是否读 stdin；若不支持则退回引号拼装，并把「中文 + 双引号 + 多行」列入回归用例。

## 变更记录

- 2026-11-13 初稿：登记现状（WSL-only 链路逐处核对）、环境判定规则、runner 拆分、runstate、接口与验收；状态「方案待确认」。
