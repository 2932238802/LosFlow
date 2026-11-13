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
        └───┬────────┬───┘        │  runstate/streams │
            │        │            └──────────────────┘
   spawn    │        │ spawn runner（按项目的 env）
            ▼        ▼
   agent/*.ps1   ┌──────────────┬───────────────────────┐
   （编排）      │ env=wsl      │ env=windows           │
                │ wsl.exe →    │ claude.exe（本机）    │
                │ start_claude │ stream-json →         │
                │ _code_jz     │ data/runstate         │
                └──────────────┴───────────────────────┘
```

派单环境是**一等字段**：`server/env.mjs` / `agent/_paths.ps1` 用同一套规则从 repo 路径判定 `wsl` / `windows`，编排层（去重、预算、续接、审批、台账）与执行层（runner）分离；两个 runner 只负责「把这条活跑起来」，回执/流/pid 回到同一条管线。

## 后端模块边界

| 文件 | 负责 | 不负责 |
| --- | --- | --- |
| `server.mjs` | HTTP 路由、静态托管、SSE 拼装、维护任务、`/api/state` 组装 | 具体业务规则 |
| `store.mjs` | `data/*.json` 的统一读写：`readJson` / `mutate`（进程内写入串行 + 临时文件 rename 原子替换） | 业务字段 |
| `pool.mjs` | 任务池 CRUD、工作类型、拆分、推入 | 派单、文档同步 |
| `skills.mjs` | 提示词 SKILL（`docs/skills/*.md`）：frontmatter 校验、占位符渲染、保存/备份/恢复默认 | 调 AI |
| `docsync.mjs` | 文档同步队列（连接器 fan-out / executor 取活 / direct 执行 / 重试 / 重放 / 迁移） | 真去写表格（executor 是外部 agent，direct 是连接器自己） |
| `connector-host.mjs` | 连接器注册表：扫描 `server/connectors/<id>/connector.json`、manifest 校验、按启用状态加载 `index.mjs`、配置/密钥/健康 | 具体写表逻辑 |
| `connectors/*` | 内置连接器：`tencent-wb`（executor，WorkBuddy 执行）/ `local-file`、`http-webhook`（direct，本进程执行） | — |
| `dispatch.mjs` | 调 `agent/claude-dispatch.ps1`、解析回执、终止、per-run 运行态（`data/runstate`） | 决定派什么 |
| `env.mjs` | 派单环境判定 `resolveEnv(path, explicit, defaultEnv)`（与 `agent/_paths.ps1` 同规则） | 执行 |
| `approvals.mjs` | 授权队列：live 实时请求（`data/live` 文件握手，批准当场放行同一次 run）/ legacy 事后审批（写 allowlist + 自动重派）/ 运行中拒绝兜底；新请求入队时触发 Windows 提醒 | 判断权限是否合理 |
| `notify.mjs` | Windows 桌面提醒：去重 / 8s 节流合并 / 20s 未处理再响 / 失败降级；spawn `agent/win-notify.ps1`（NotifyIcon 气球 + 声音） | 浏览器内提示 |
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
├─ utils/terminal.ts 终端渲染规则 / 摘要 / 异常提示（纯函数，有 node --test 单测）
├─ utils/split.ts    拆分结果容错解析（代码块/未转义换行/坏一条不影响其余）
├─ store/             composable 单例（零依赖，不引 Pinia）
│  ├─ useAppState     /api/state 轮询、nowMs、busy
│  ├─ useView         视图 + localStorage 记忆
│  ├─ useTasks        任务动作、快轮询、草稿持久化、结果弹层
│  ├─ useMark         「标记完成」面板（区域 / 证据；类型入池时已定）
│  ├─ useConfirm      统一确认弹层（替代 window.confirm）
│  ├─ usePool         池子、工作类型、拆分面板、推入（推入即派单）
│  ├─ useProjects     项目浏览与选择、任务工作目录选择
│  ├─ useTerminal     会话平铺日志、SSE/HTTP 按 seq 合并、跟随、筛选、删除会话
│  ├─ useLifecycle   全局连接/定时器（5s 状态兜底 / 1s 心跳 / 1 条会话 SSE / 断线重连与 visibility 对账）
│  ├─ useSettings     清理、阈值、模板
│  └─ useWb           WorkBuddy SSE + state 初始历史
├─ components/        AppSidebar / SheetShell / TaskCard / PoolPanel / NewTaskBox / SessionList / TerminalCard（会话详情）/ ApprovalDock（会话右上悬浮授权卡）/ HighlightText / AuthRail（设置页授权记录）
├─ views/             Tasks / Terminals / Done / Wb / Settings
└─ dialogs/           ProjectPicker / ProjectDialog / RepoDialog / SplitDialog / TemplateDialog / MarkDialog / ResultSheet / ConfirmDialog
```

**状态归属**：跨视图状态（卡片展开态、终端滚动、提示词草稿、弹层开关）都放 `store/`；视图用 `<KeepAlive>` 保活，切走再回来不重建（滚动位置、展开态、已渲染行数都留着）。组件内只保留 DOM 引用。

**改模板注意**：从 store 导入的 ref 在模板里读取会自动解包，但赋值不会（会写到 ref 对象上）。所有写入都走 store 暴露的 setter（如 `setView` / `setNewTitle` / `toggleFull`），`reactive` 对象（`markForm` / `tpl`）的字段可直接 `v-model`。

| 视图 | 内容 |
| --- | --- |
| 任务 | 任务池 + 已推入任务 + 卡片详情（提示词、执行、会话入口） |
| 会话 | 左会话列表 + 右详情：一条连续平铺日志、搜索过滤、跟随；授权请求在**会话右上角悬浮卡**（覆盖日志、不占布局，当前会话排最前）；过期后留「接着跑」 |
| 已完成 | 归档任务 + 归档的池子（侧栏底部入口，价钱上方） |
| WorkBuddy / 设置 | MCP 调用记录、项目与历史清理 |

`/` 与 `/index.html` 302 到 `/app/`；`server/index.html`（早期 FLOW 原型）已不再托管。

## 关键契约

- **任务表是唯一真源**：`data/Vesta.tasks.json`，字段 `id/subject/owner/status/note/repo/evidence/sessionId/docSync`；创建/推入时定 `workType`（`dev` / `docs` / `plan`；旧数据的 `review` 读作 `docs`），人工验收另加 `area`（`{kind:"code"|"docs",path}`）、`finishedAt`，旧任务缺省不报错。`docOnly: true` 表示文档同步类任务（历史遗留），不进任务页/会话页。派单相关另加 `env`（`auto` / `wsl` / `windows`；派单时固化为具体环境）、`sessionEnv`（会话来自哪个环境）、`lastError`（preflight / 失败的最近原因）。
- **任务本身 = note**：池子条目、任务行的 `note` 只放「真正发给 Claude Code 的正文」。优先级是独立字段，文档簿记不写进 `note`。拆出来的子条目必须自带 `note`（缺省时沿用父正文；仍为空 → 400），推入时正文为空 → 400；自动派单的提示词也只取这条 `note`。
- **工作类型在入池时定**：`workType` = `dev` / `docs` / `plan`，新建任务与拆分弹层里选择，子条目默认继承父条目（可单独改）。优化提示词按类型选 `optimize-{dev,docs,plan}.md`；推入建任务时写进任务行；「标记完成」不再选类型，只补区域与证据。
- **拆分**：父条目记录 `children`（子条目的 **pool id**）；推入后任务 id 记在 `pushedTaskIds`，`children` 不再被覆盖。删父不级联删子（子条目显示「父条目已删除」）。
- **提示词 SKILL**：`docs/skills/{split,optimize,optimize-dev,optimize-docs,optimize-plan,split-optimize}.md`，frontmatter 声明 `name/output/fields`，正文是系统提示，占位符 `{{title}} / {{note}} / {{extra}} / {{schema}}`；保存时校验、旧版备份到 `.history/`。改 SKILL 不需要重启（每次请求现读）。
- **环境分流**：`resolveEnv()` 按路径形态判定（`server/env.mjs` + `agent/_paths.ps1` 同一套规则）：`~/`、`/` 开头 → wsl；`X:\`、`X:/`、`\\` 开头 → windows；空 → `defaultEnv`。两个 runner（`agent/runners/run-wsl.ps1` / `run-windows.ps1`）只负责执行，编排（去重 / 预算 / 续接 / allowlist / 审批 / 台账 / running.json）都在 `claude-dispatch.ps1`。去重 hash 含 env，同一句话在两边是两次活。
- **per-run 运行态**：`data/runstate/<runId>.json` 记 `{id,taskId,env,repo,stream,pid,startedAt}`，由 runner 在 preflight 通过后写，派单结束归档流后删除；异常退出由 30 分钟宽限期清理。终止按 env 路由（Windows `pid` → `taskkill /T /F`；WSL `/tmp/cc-<id>.pid`）；终端页合并 WSL pid + 本地 runstate，`items[].env` 标归属。
- **preflight**：环境不匹配 / 找不到 repo / 找不到 claude 或版本过低 / WSL 共享不可写 → `status=preflight`、`rc=90`，**不写**台账、不写 running.json、不产生审批，前端提示「环境检查未通过，未产生花费」。
- **写入串行化**：所有 `data/*.json` 的读-改-写都走 `store.mutate()`（进程内队列 + 临时文件 rename）。异步派单后回执、标记完成、池子推入可能并发落盘，不串行会互相覆盖。
- **派单是投递型**：`/api/task/dispatch`、`/api/task/continue` 只写 `pending.json` 的「启动中」标记就返回 `{started:true}`，子进程在 `setImmediate` 里跑；`/api/state` 的 `tasks[].starting` 让卡片立刻显示「执行中（启动中）」，后台结束后写回执 / `sessionId` 并清标记。
- **每张卡认自己的会话**：`/api/state` 的 `tasks[].running` 是该任务活着的 runId（WSL pid ∩ 台账）；`POST /api/run/stop {taskId}` 只杀这个 runId，不再误杀别的任务。
- **会话流**：一条 `GET /events/losflow` 多路复用（最多 8 条任务，`taskId` 区分），服务端按 runId 增量读 stream-json，只消费完整行，附带 `seq`；不再每张卡一条 SSE / 每 2s 整包重取。
- **流文件解析**（`events.resolveRunFile`）：`data/streams/<id>.jsonl`（archive）→ runstate 里记录的 stream（运行中，source=`wsl`/`windows`）→ `data/runstate/<id>.stream.jsonl` → WSL `/tmp/cc-<id>.stream.jsonl`（旧数据）→ `missing`。实时 SSE 与历史回放共用同一条解析；派单结束后 Windows 的临时流归档并删除。
- **轮 + 动作契约（兼容保留）**：`GET /api/task/raw?v=2` 仍返回 `rounds[] / stats / end`（每条 assistant 消息一轮、`tool_use` 与 `tool_result` 按 `tool_use_id` 配对），供验收/摘要兼容；会话页渲染改用同响应里的 `lines[]`。默认最后 40 轮，`before` 往前翻；`after` / `beforeSeq` 按行 seq 增量对账；单响应 2 MB 上限。回放源见上一条；`/api/task/stream` 下载原始日志。回执缺金额时 `end.cost = null`，前端显示「—」。
- **写文档不占任务行**：append-row / update-row / 整理主表按**启用连接器 fan-out**；executor（tencent-wb）走 `docsync` 队列由 WorkBuddy 取走，direct（local-file / http-webhook）由 server 直接执行并各自重试。新建任务入口（`taskboard.ps1 -Add`、wb-bridge `add_task`）命中文档操作指令直接拒建；`/api/task/dispatch`、`/api/task/continue` 对 `docOnly` 任务直接 400 兜底。
- **连接器**：`data/connectors.json` 存配置（target / mapping / actions / match / queue），`data/secrets.json` 只存密钥；`/api/connectors` 增删改 / 测试行 / 重放失败，`/api/state.connectors` 带健康与队列统计。代码里不再出现具体表格 URL、tab id、列名——都在 tencent-wb 的默认配置里，设置页可改。
- **派单回执 ≠ 任务完成**：回执只说明 Claude 跑完了。人在会话页点「标记完成」，经 `POST /api/task/status` 写 `done` + 区域/证据（工作类型沿用入池时定的值）；`done` 时给 docsync 入队一条 `update-row`（WorkBuddy 按任务名改主表状态与备注），并触发自动整理计数（`docOnly` 任务不计入）。
- **推入 = 两条线，且立刻派单**：任务本体落库后，Claude Code 任务自动派单（提示词就是 `note`），WorkBuddy 任务等 WB 取走；文档那一行进 `docsync` 队列，异步回调后再推进。
- **会话渲染单位**：一条连续平铺日志（`lines[]`，`seq` 由文件字节偏移派生）。`cmd/out/err` 按 `actionId` 归并；`think/say/end/report` 顺序平铺；工具 → 中文动作的规则在 `utils/terminal.ts`，未知工具降级为原始名 + JSON。SSE 与 HTTP 回填按 `seq` 合并去重，断线/切后台/服务重启后自动对账（`after`）。
- **授权提示位置**：会话右上悬浮卡（`ApprovalDock`，绝对定位覆盖在日志上，不占文档流，不参与页面/日志滚动）；当前会话的请求排最前，其他会话排后面并可「切过去」；全屏同样可见。批准语义不变（live 同 run 继续，legacy/midRun 重派）。漏批后转灰条并给「接着跑（续接）」。`Ctrl+Enter` / `Ctrl+Backspace` 是全局快捷键（焦点在输入框时不拦截）。
- **Windows 提醒**：`approvals.mjs` 在新 live 请求入队时调 `notify.mjs` → spawn `agent/win-notify.ps1`（NotifyIcon 气球 + 声音）。8s 节流合并、20s 未处理再响一次；`notify.enabled=false` 或非 Windows 时不弹，状态写入 `/api/state.notify`。
- **回执 JSON**（`claude-dispatch.ps1 -JsonOut`）：`id,status,rc,session_id,turns,cost_usd,denials,suggested_allow,result`。

## 部署形态

单机：Windows 侧跑 `node server/server.mjs`（8899），按项目环境分别调用 WSL2 里的 `start_claude_code_jz` 或本机 `claude.exe`。没有数据库、没有容器、没有外部依赖；`data/` 拷走即可迁移。提示词优化 / 拆分 / 文档生成这类元调用直连网关（配置来源 `windowsClaudeEnv` → 本机环境变量 → WSL 启动器兜底），不再依赖 WSL 在线。
