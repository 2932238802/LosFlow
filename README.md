# LosFlow

**定位：DSH 插件 + 工作流驾驶舱。** 把「提需求 → 拆任务 → 派给 Claude Code → 看它干 → 收授权 → 台账落文档」这一整条流水线做成看得见、管得住的一处。

不是另一个聊天框，而是 DSH 右边那块**干活的面板**：任务池、会话回放、授权队列、腾讯文档同步。

## 一条任务的生命

```
加入池子（选工作类型：开发 / 文档 / Plan）→ 拆分（每条子任务必须带「任务本身」，类型默认继承）→ 推入 ─┬─ 任务本体：落库后自动派单，提示词就是「任务本身」
                                                                              └─ 文档那一行：异步入队，WorkBuddy 有空再写，写完回调
派单 → 会话里看它思考/命令/结果 → 撞权限墙 → 会话右上悬浮授权卡（Windows 提醒 + 全局 Ctrl+Enter）→ 同一 run 继续（不重派，规则可记住）
验收 → 会话里点「标记完成」补区域（代码区 / 文档区）与证据；工作类型入池时已定
回填 → 台账 + 腾讯文档任务表 → 归档
```

## 目录

```
losflow/
├─ web/                 前端（Vue 3 + Vite）：驾驶舱 SPA
├─ server/              后端（Node，零依赖）：HTTP API + SSE + 静态托管
├─ agent/               Windows 侧：PowerShell 派单脚本 + WorkBuddy MCP 桥
├─ packages/dsh-plugin/ DSH 右侧栏插件（把 /app/ 挂进 DSH）
├─ data/                运行时数据（git 忽略）：任务表、池子、台账、runs、审批队列
├─ scripts/             dev / smoke 等
└─ docs/                架构、接口、运行手册；docs/skills/ 是提示词 SKILL（拆分/优化，可编辑）
```

## 快速开始

```powershell
# 1. 机器相关配置（可选，默认值见 losflow.config.example.json）
Copy-Item losflow.config.example.json losflow.config.json

# 2. 装前端依赖 + 构建
npm --prefix web install
npm run build

# 3. 起服务（默认 8899）
npm start
# → http://127.0.0.1:8899/app/

# 之后更新代码：构建 + 类型检查 + 单测 + 冒烟 + 接管端口
# （有任务在跑会拒绝重启；只检查不重启用 --check-only）
update.bat
```

开发模式（后端 + vite 热更新）：

```powershell
npm run dev       # server:8899 + vite:5174，vite 已代理 /api 与 /events
```

冒烟：

```powershell
npm run smoke     # 起临时端口，断言 /api/state、/api/docsync、/app/、/wiki
```

## 依赖的外部东西

| 东西 | 用途 | 必需 |
| --- | --- | --- |
| WSL2（默认 `Ubuntu-26.04`）+ `/usr/bin/start_claude_code_jz` | WSL2 项目的 Claude Code（one-api 网关） | 派 WSL2 项目时才需要 |
| Windows 的 Claude Code（`claude.exe` ≥ 2.1.0） | Windows 项目的 Claude Code（同一网关） | 派 Windows 项目时才需要 |
| Python 3（WSL 自带 `python3`；Windows 用 `py -3` 或配置 `pythonCmd`） | 实时授权 MCP（`agent/approval-mcp.py`），把 Claude Code 的「问人」接到会话右上悬浮卡 + Windows 提醒 | 实时授权时需要；`liveApprove:false` 可退回旧的事后审批 |
| WorkBuddy + 腾讯文档连接器 | 写任务表、消费文档同步队列 | 文档同步才需要 |
| DSH | 承载右侧栏插件 | 用面板才需要 |

两边**互不干涉**：各用各的 CLI、配置、会话、进程与临时文件；WSL 停掉不影响 Windows 派单，反之亦然。

## 派单环境（WSL2 / Windows）

项目的执行环境按**路径形态**判定（`server/env.mjs` 与 `agent/_paths.ps1` 同一套规则）：

| repo 路径 | 环境 |
| --- | --- |
| `~/...`、`/...`（含 `/mnt/d/...`） | `wsl` |
| `D:\...`、`D:/...`、`\\NAS\...` | `windows` |
| 空（老任务）/ `env: "auto"` | `defaultEnv`（默认 `wsl`） |

`/mnt/d/...` 判成 WSL 是故意的：环境跟随路径形态，不跟随磁盘在哪。要 Windows 跑 D 盘项目，就在项目里登记 Windows 路径。

项目可以显式指定 `env`（`auto` / `wsl` / `windows`）；任务在派单时把判定结果固化到 `env`，改目录会重置成 `auto` 重新判定。环境与路径不匹配时在**花钱之前**报 `status=preflight`（`rc=90`），不写台账、不产生花费。

Windows 侧配置（`losflow.config.json`，gitignored）：

| 字段 | 含义 | 默认 |
| --- | --- | --- |
| `defaultEnv` | 空 repo 时走哪个环境 | `wsl` |
| `windowsClaudeCmd` | Windows 侧 `claude.exe` 路径，空则自动解析 | `""` |
| `windowsClaudeArgs` | 每次追加的参数（如 `--settings`） | `[]` |
| `windowsClaudeEnv` | 注入子进程的环境变量（JZ 网关三件套；key 只写这里，不进 git） | `{}` |
| `claudeTimeoutSec` | 单次派单超时（秒） | `600` |

`windowsClaudeEnv` 留空时继承本机环境（shell 里已注入网关 / 已登录的账号都可用）；填了就先把子进程的 `ANTHROPIC_*` 清掉再注入，绝不混用两边的认证。

## 数据在哪

`data/` 下：

| 文件 | 作用 |
| --- | --- |
| `pool.json` | 任务池 |
| `Vesta.tasks.json` | 任务表（唯一真源） |
| `docsync.json` | 文档同步队列（异步回调） |
| `approvals.json` / `allowlist.json` | 授权队列与已放行规则（`live:true` 为执行前实时请求） |
| `live/` | 实时授权的文件握手：`<id>.req.json`（MCP 写）/ `<id>.res.json`（服务端写），结案进 `live/archive/` |
| `claude-ledger.jsonl` | 派单台账（花费/轮次/回执摘要） |
| `runs/` | 每次派单的回执台账 |
| `streams/` | 每次派单的 stream-json 回放归档（默认保留 7 天，随清理一起删） |
| `runstate/` | 每次派单的运行态（`<runId>.json` + Windows 侧的临时流/pid），跑完即归档并清理 |
| `calls.jsonl` | WorkBuddy 的 MCP 调用记录 |

全部 git 忽略。换机器时拷 `data/` 即可接上历史。

## 开发约定

- 后端零依赖：只用 Node 内置模块，不开框架。
- 前端入口 `web/src/App.vue` 只做 shell；视图在 `web/src/views/`，跨视图状态在 `web/src/store/`，新增视图照着现有目录加。改动前先看 `docs/architecture.md` 的前端边界。
- 涉及工作流语义（阶段、推入、文档同步、授权）的改动，**先改 `docs/`，再改代码**。
- 提交前跑 `npm run smoke`；动前端再加 `npm run build`。
- 机器相关的路径/端口不要写死在代码里，走 `losflow.config.json` 或环境变量（`server/paths.mjs`、`agent/_paths.ps1`）。
