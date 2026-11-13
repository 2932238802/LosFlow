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
| `server.mjs` | HTTP 路由、静态托管、SSE 拼装、维护任务、`/api/state` 组装 | 具体业务规则 |
| `store.mjs` | `data/*.json` 的统一读写：`readJson` / `mutate`（进程内写入串行 + 临时文件 rename 原子替换） | 业务字段 |
| `pool.mjs` | 任务池 CRUD、拆分、推入（三项确认） | 派单、文档同步 |
| `docsync.mjs` | 文档同步队列（enqueue / enqueueMaintenance / next / report / 重试 / 文档指令判定） | 真去写表格（那是 WorkBuddy） |
| `dispatch.mjs` | 调 `agent/claude-dispatch.ps1`、解析回执、终止 | 决定派什么 |
| `approvals.mjs` | 授权队列：批准/拒绝/写 allowlist/自动重派 | 判断权限是否合理 |
| `events.mjs` | 解析 stream-json、`readRunRounds()`（轮 + 动作 / 分页 / stats）、`/events/losflow` 多路复用增量推、WorkBuddy 调用流 | 布局与渲染 |
| `paths.mjs` | 一切路径解析（仓库内默认 + 配置覆盖；含 `data/streams` 回放归档目录） | — |

## 前端边界

`web/src/` 按「壳 + 视图 + 组件 + 状态」分层，`App.vue` 只做 shell（侧栏 + 视图路由 + 弹层挂载）：

```
web/src/
├─ App.vue            shell：侧栏 / KeepAlive 视图 / 弹层挂载
├─ types.ts           与服务端 /api/state 对齐的类型 + View
├─ api.ts             getJSON / post（统一 x-dash、错误体提取）
├─ utils/format.ts    纯展示函数（阶段、证据、路径…）
├─ utils/terminal.ts  终端渲染规则 / 摘要 / 异常提示（纯函数，有 node --test 单测）
├─ store/             composable 单例（零依赖，不引 Pinia）
│  ├─ useAppState     /api/state 轮询、nowMs、busy
│  ├─ useView         视图 + localStorage 记忆
│  ├─ useTasks        任务动作、快轮询、草稿持久化、结果弹层
│  ├─ useMark         「标记完成」面板（类型 / 区域 / 证据）
│  ├─ useConfirm      统一确认弹层（替代 window.confirm）
│  ├─ usePool         池子、三项确认、拆分面板、推入
│  ├─ useProjects     项目浏览与选择、任务工作目录选择
│  ├─ useTerminal     会话增量流、轮/动作、跟随、筛选、删除会话
│  ├─ useSettings     清理、阈值、模板
│  ├─ useWb           WorkBuddy SSE + state 初始历史
│  └─ useLifecycle    全局连接/定时器（5s 状态兜底 / 1s 心跳 / 1 条会话 SSE）
├─ components/        AppSidebar / SheetShell / TaskCard / PoolPanel / NewTaskBox / SessionList / TerminalCard（会话详情）/ HighlightText / AuthRail
├─ views/             Tasks / Terminals / Done / Wb / Settings
└─ dialogs/           ProjectPicker / ProjectDialog / RepoDialog / SplitDialog / TemplateDialog / MarkDialog / ResultSheet / ConfirmDialog
```

**状态归属**：跨视图状态（卡片展开态、终端滚动、提示词草稿、弹层开关）都放 `store/`；视图用 `<KeepAlive>` 保活，切走再回来不重建（滚动位置、展开态、已渲染行数都留着）。组件内只保留 DOM 引用。

**改模板注意**：从 store 导入的 ref 在模板里读取会自动解包，但赋值不会（会写到 ref 对象上）。所有写入都走 store 暴露的 setter（如 `setView` / `setNewTitle` / `toggleFull`），`reactive` 对象（`markForm` / `tpl`）的字段可直接 `v-model`。

| 视图 | 内容 |
| --- | --- |
| 任务 | 任务池 + 已推入任务 + 卡片详情（提示词、执行、会话入口） |
| 会话 | 左列表 + 右详情：轮/动作、搜索过滤、跟随、右侧授权栏 |
| 已完成 | 归档任务 + 归档的池子（侧栏底部入口，价钱上方） |
| WorkBuddy / 设置 | MCP 调用记录、项目与历史清理 |

`/` 与 `/index.html` 302 到 `/app/`；`server/index.html`（早期 FLOW 原型）已不再托管。

## 关键契约

- **任务表是唯一真源**：`data/Vesta.tasks.json`，字段 `id/subject/owner/status/note/repo/evidence/sessionId/docSync`；人工验收另加 `workType`（`dev/review/plan`）、`area`（`{kind:"code"|"docs",path}`）、`finishedAt`，旧任务缺省不报错。`docOnly: true` 表示文档同步类任务（历史遗留），不进任务页/会话页。
- **写入串行化**：所有 `data/*.json` 的读-改-写都走 `store.mutate()`（进程内队列 + 临时文件 rename）。异步派单后回执、标记完成、池子推入可能并发落盘，不串行会互相覆盖。
- **派单是投递型**：`/api/task/dispatch`、`/api/task/continue` 只写 `pending.json` 的「启动中」标记就返回 `{started:true}`，子进程在 `setImmediate` 里跑；`/api/state` 的 `tasks[].starting` 让卡片立刻显示「执行中（启动中）」，后台结束后写回执 / `sessionId` 并清标记。
- **每张卡认自己的会话**：`/api/state` 的 `tasks[].running` 是该任务活着的 runId（WSL pid ∩ 台账）；`POST /api/run/stop {taskId}` 只杀这个 runId，不再误杀别的任务。
- **会话流**：一条 `GET /events/losflow` 多路复用（最多 8 条任务，`taskId` 区分），服务端按 runId 增量读 stream-json，只消费完整行，附带 `seq`；不再每张卡一条 SSE / 每 2s 整包重取。
- **轮 + 动作契约**：`GET /api/task/raw?v=2` 把一条 assistant 消息作为一轮、把 `tool_use` 与 `tool_result` 按 `tool_use_id` 配对成动作，返回 `rounds[] / stats / end`；默认最后 40 轮，`before` 往前翻，单响应 2 MB 上限。回放源依次是 `data/streams/<id>.jsonl`（派单结束时从 WSL `/tmp` 归档）→ WSL `/tmp` → `missing`（前端显式提示，不空白）。`/api/task/stream` 下载原始日志。
- **写文档不占任务行**：append-row / update-row / 整理主表只走 `docsync` 队列 → WorkBuddy，不建任务、不进任务池、不进会话、不派给 Claude Code。新建任务入口（`taskboard.ps1 -Add`、wb-bridge `add_task`）命中文档操作指令直接拒建；`/api/task/dispatch`、`/api/task/continue` 对 `docOnly` 任务直接 400 兜底。
- **派单回执 ≠ 任务完成**：回执只说明 Claude 跑完了。人在会话页点「标记完成」，经 `POST /api/task/status` 写 `done` + 类型/区域/证据；`done` 时给 docsync 入队一条 `update-row`（WorkBuddy 按任务名改主表状态与备注），并触发自动整理计数（`docOnly` 任务不计入）。
- **推入 = 两条线**：任务本体立刻可开工；文档那一行进 `docsync` 队列，异步回调后再推进。池条目的三项确认（细则 / 流程 / 授权）在卡片上勾选；勾了「授权」则推入后自动派单。
- **会话渲染单位**：轮（`round.i`）+ 动作（`tool_use_id`）；工具 → 中文动作的规则在 `utils/terminal.ts`，未知工具降级为原始名 + JSON。`think` 弱化为灰色斜体，`err` 动作左侧红条。
- **回执 JSON**（`claude-dispatch.ps1 -JsonOut`）：`id,status,rc,session_id,turns,cost_usd,denials,suggested_allow,result`。

## 部署形态

单机：Windows 侧跑 `node server/server.mjs`（8899）+ WSL2 里跑 Claude Code。没有数据库、没有容器、没有外部依赖；`data/` 拷走即可迁移。
