# LosFlow

**定位：DSH 插件 + 工作流驾驶舱。** 把「提需求 → 拆任务 → 派给 Claude Code → 看它干 → 收授权 → 台账落文档」这一整条流水线做成看得见、管得住的一处。

不是另一个聊天框，而是 DSH 右边那块**干活的面板**：任务池、会话回放、授权队列、腾讯文档同步。

## 一条任务的生命

```
加入池子 → 拆分(cc:/wb:) → 推入 ─┬─ 任务本体：立刻可开工，派给 Claude Code（或在池子里等）
                                 └─ 文档那一行：异步入队，WorkBuddy 有空再写，写完回调
派单 → 会话里看它思考/命令/结果 → 撞权限墙 → 右侧授权栏批准 → 规则进 allowlist → 自动重派一次
验收 → 会话里点「标记完成」标注类型（开发 / review / Plan）与区域（代码区 / 文档区）
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
└─ docs/                架构、接口、运行手册
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
| WSL2（默认 `Ubuntu-26.04`） | 跑 Claude Code | 派单才需要 |
| `/usr/bin/start_claude_code_jz` | Claude Code 启动器（one-api 网关） | 派单才需要 |
| WorkBuddy + 腾讯文档连接器 | 写任务表、消费文档同步队列 | 文档同步才需要 |
| DSH | 承载右侧栏插件 | 用面板才需要 |

## 数据在哪

`data/` 下：

| 文件 | 作用 |
| --- | --- |
| `pool.json` | 任务池 |
| `Vesta.tasks.json` | 任务表（唯一真源） |
| `docsync.json` | 文档同步队列（异步回调） |
| `approvals.json` / `allowlist.json` | 授权队列与已放行规则 |
| `claude-ledger.jsonl` | 派单台账（花费/轮次/回执摘要） |
| `runs/` | 每次派单的回执台账 |
| `streams/` | 每次派单的 stream-json 回放归档（默认保留 7 天，随清理一起删） |
| `calls.jsonl` | WorkBuddy 的 MCP 调用记录 |

全部 git 忽略。换机器时拷 `data/` 即可接上历史。

## 开发约定

- 后端零依赖：只用 Node 内置模块，不开框架。
- 前端入口 `web/src/App.vue` 只做 shell；视图在 `web/src/views/`，跨视图状态在 `web/src/store/`，新增视图照着现有目录加。改动前先看 `docs/architecture.md` 的前端边界。
- 涉及工作流语义（阶段、推入、文档同步、授权）的改动，**先改 `docs/`，再改代码**。
- 提交前跑 `npm run smoke`；动前端再加 `npm run build`。
- 机器相关的路径/端口不要写死在代码里，走 `losflow.config.json` 或环境变量（`server/paths.mjs`、`agent/_paths.ps1`）。
