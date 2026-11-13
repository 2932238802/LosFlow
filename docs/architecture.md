# 架构

## 一张图

```
┌─ DSH（聊天 + 右侧栏插件） ─────────────┐
│  packages/dsh-plugin → iframe /app/    │
└───────────────┬────────────────────────┘
                │ HTTP / SSE
        ┌───────▼────────┐        ┌──────────────────┐
        │ server/*.mjs   │◄──────►│  data/（本地文件）│
        │  Node 零依赖   │        │  任务表/池子/台账 │
        └───┬────────┬───┘        └──────────────────┘
            │        │
   spawn    │        │ spawn
            ▼        ▼
   agent/*.ps1   wsl.exe → /usr/bin/start_claude_code_jz
   （派单）        （Claude Code，stream-json 写到 WSL /tmp）
```

## 后端模块边界

| 文件 | 负责 | 不负责 |
| --- | --- | --- |
| `server.mjs` | HTTP 路由、静态托管、SSE 拼装、维护任务 | 具体业务规则 |
| `pool.mjs` | 任务池 CRUD、拆分、推入 | 派单、文档同步 |
| `docsync.mjs` | 文档同步队列（enqueue / next / report / 重试） | 真去写表格（那是 WorkBuddy） |
| `dispatch.mjs` | 调 `agent/claude-dispatch.ps1`、解析回执、终止 | 决定派什么 |
| `approvals.mjs` | 授权队列：批准/拒绝/写 allowlist/自动重派 | 判断权限是否合理 |
| `events.mjs` | 解析 Claude stream-json、tail 日志、生成终端行 | 布局与渲染 |
| `paths.mjs` | 一切路径解析（仓库内默认 + 配置覆盖） | — |

## 前端边界

`web/src/App.vue` 目前是单文件（约 900 行），按视图分区：

| 视图 | 内容 |
| --- | --- |
| 任务 | 任务池 + 已推入任务 + 卡片详情（提示词、执行、终端入口） |
| 终端 | 会话列表、stream 回放、右侧授权栏 |
| 已完成 / WorkBuddy / 文档 / 设置 | 归档、MCP 调用记录、wiki、项目与历史清理 |

拆分方向（待做）：`components/TaskCard.vue`、`components/TerminalCard.vue`、`components/AuthRail.vue`、`components/PoolPanel.vue`、`views/Settings.vue`。

## 关键契约

- **任务表是唯一真源**：`data/Vesta.tasks.json`，字段 `id/subject/owner/status/note/repo/evidence/sessionId/docSync`。
- **阶段推断**（`inferStage`）：没有任务=①；有 todo 且文档未同步=②；文档同步完=③；doing=⑤/⑥；全完=⑧。
- **推入 = 两条线**：任务本体立刻可开工；文档那一行进 `docsync` 队列，异步回调后再推进阶段。
- **终端行类型**：`think`（思考）/`cmd`（命令）/`out`（输出）/`err`/`say`/`end`/`report`（回执全文）。
- **回执 JSON**（`claude-dispatch.ps1 -JsonOut`）：`id,status,rc,session_id,turns,cost_usd,denials,suggested_allow,result`。

## 部署形态

单机：Windows 侧跑 `node server/server.mjs`（8899）+ WSL2 里跑 Claude Code。没有数据库、没有容器、没有外部依赖；`data/` 拷走即可迁移。
