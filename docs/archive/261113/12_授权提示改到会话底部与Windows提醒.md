# 12 · 授权提示：从右侧栏搬到会话底部 / 悬浮在会话上，并加 Windows 提醒

| 项 | 内容 |
| --- | --- |
| 编号 | 12 |
| 日期 | 2026-11-13 |
| 项目 | LosFlow（`D:\PROJECT\LosFlow`） |
| 类型 | 前端位置重构为主（不改批准语义）+ 服务端新增通知模块 + 配置/文档 |
| 状态 | 已实施（2026-11-13：底部接管条 / 悬浮卡 / 平铺日志 + 自愈 / Windows 提醒） |
| 提出 | 杰哥（2026-11-13：「确认一下当前需要 Auth 提权的现状；我不太喜欢侧边提权，可以是对话的下边，也可以是悬浮在对应会话上面；然后希望有 Windows 提醒，不然提权有时候没看到」） |
| 涉及文件 | `web/src/views/TerminalsView.vue`、`web/src/components/AuthRail.vue`、`web/src/components/ApprovalDock.vue`（新增）、`web/src/components/ApprovalFloat.vue`（新增）、`web/src/components/SessionList.vue`、`web/src/components/AppSidebar.vue`、`web/src/term.css`、`web/src/store/useLifecycle.ts`、`web/src/types.ts`；`server/approvals.mjs`、`server/notify.mjs`（新增）、`server/server.mjs`、`agent/win-notify.ps1`（新增）、`losflow.config.example.json`、`docs/api.md`、`README.md`、`docs/architecture.md` |

## 一句话结论

**卡片位置错、没有第二条提醒通道，而且漏批之后是死路。** 现在授权卡只存在于「会话」页的**第三栏**（右侧 360px），而且是**全局一份**、不跟会话走；服务端 300ms 扫到新请求后只推一条 SSE，页面上没有任何声音/系统通知，50 秒没人点就自动拒绝，过期记录**直接从界面消失**、会话页也没有「重新跑」的入口。改法四条：① 卡片从侧栏搬到**会话底部**（接管「输入框」那个位置，和 DSH 自己的审批同一范式），非当前会话的请求用**悬浮小卡**挂在对应会话上；② 服务端在**新请求入队那一刻**打 Windows 通知（本机实测：WinRT toast 不可用，`NotifyIcon` 气球可用）+ 声音，超时前再响一次；③ 漏批后 dock 留灰条并给「接着跑（续接）」；④ 会话详情去掉「第 N 轮 / 动作」这一层，改成一条连续日志，并保证日志在授权等待/断线后自愈、不需要刷新。

---

## 1. 现状：核对到代码行

### 1.1 一条授权请求现在走哪条路

| # | 环节 | 位置 | 现在做什么 |
| --- | --- | --- | --- |
| 1 | Claude Code 要执行一条不在白名单里的调用 | `agent/runners/run-wsl.ps1:121`、`agent/runners/run-windows.ps1:218-220` | 通过 `--permission-prompt-tool mcp__losflow-approval__approval_prompt` 把「问人」转给我们自己的 MCP |
| 2 | MCP 写请求文件并等待 | `agent/approval-mcp.py:186-216`、`:158-177` | 写 `data/live/<id>.req.json`，每 200ms 轮询 `.res.json`；**默认等 50s（上限 55）**，超时直接返回 deny |
| 3 | 服务端扫目录入队 | `server/approvals.mjs:217-287`（`scanLive`，`setInterval` 300ms，见 `:295`） | 新 req → 写 `approvals.json` 记录（`status:"pending"`, `live:true`, `expiresAt`），然后 `notify("waiting", rec)`（`:240`） |
| 4 | 推给前端 | `server/server.mjs:44`（`startLiveWatch((evt) => events.broadcast(evt))`） | SSE `/events/losflow` 推 `{kind:"approval",action:"waiting",approval}` |
| 5 | 前端收到事件 | `web/src/store/useLifecycle.ts:31-43` | 收到 `kind=approval` 就 `refresh()` 整包重取 `/api/state` |
| 6 | 状态里带授权 | `server/server.mjs:720` | `approvals: loadApprovals().slice(-20).reverse()`（**只带最近 20 条**） |
| 7 | 渲染 | `web/src/views/TerminalsView.vue:84-96` + `web/src/components/AuthRail.vue:8` | 有 pending 时把网格切到三栏，第三栏渲染 `AuthRail`（全部 pending，不分会话） |
| 8 | 布局 | `web/src/term.css:71-72`、`:152`、`:169-172` | 网格三列 `300px / 1fr / 360px`；`max-width:1100px` 时 `with-rail` 塌成一栏、`.auth-rail` 变 static |
| 9 | 其它页面的入口 | `web/src/components/AppSidebar.vue:38-40` | 侧栏底部一行 `AUTH N 条等你批`，点一下跳到会话页 |
| 10 | 人点了批准 | `server/approvals.mjs:323-353` → `/api/approve`（`server/server.mjs:1220`） | 写 `<id>.res.json`，MCP 读到后 allow，**同一次 run 继续**，不重派 |
| 11 | 没人点 | `agent/approval-mcp.py:176-177` + `server/approvals.mjs:276-283` | MCP 侧超时 deny；服务端双保险再写一次 deny，卡片标 `expired` |

**批准语义本身是好的（live 同 run 继续），这次要动的只有「在哪看见」和「怎么被叫醒」。**

### 1.2 位置上的事实

- **卡片不跟会话**：`AuthRail.vue:8` 取的是全局 `approvals` 过滤 `status==="pending"`；卡片上只有 `taskSubject` / `runId` 的**文字**（`AuthRail.vue:20-24`）。人在看会话 #9 时，为会话 #12 点批准，UI 不会有任何「你正在批另一条会话」的提示，也不会跳过去。
- **常驻第三栏要吃掉 360px**：`term.css:72`。一条 run 连发十几次请求时，右栏堆成一列，命令原文被压成窄条（`.ac-cmd` 有 `max-height:160px` 的独立滚动区），会话正文同时变窄。
- **窄面板里它其实是「页面最下面」**：面板嵌在 DSH 右侧栏（iframe 常见宽度 360–560px）时，`@media (max-width:1100px)`（`term.css:169-172`）把 `with-rail` 打回单列，`AuthRail` 变成**整段会话下方的最后一块**——要滚到底才看得到，比侧栏更差。
- **别的页面只有一行小字**：`AppSidebar.vue:38-40`；面板收起/滚动/切到 WorkBuddy 页时基本等于没有提示。
- **零声音、零系统通知**：全仓没有任何系统级提醒实现（`web/src/store/useToast.ts` 只是页内提示条；`server.mjs:1109` 那句「取活提醒」是给 WorkBuddy 的文案，不是通知）。

### 1.3 真机数据：请求是**成串**来的

`data/approvals.json`（2026-11-13 19:48–19:58，run `20261113-194841-1d757b`）：

| 指标 | 值 |
| --- | --- |
| 记录总数 | 30（29 approved，1 pending） |
| `live:true` 请求 | 28 条，全部落在同一条 run 上 |
| 等待时长（`waitedMs`，n=27） | 最小 1.3s / **中位 3.9s** / 最大 23.6s |
| 典型分布 | 19:52:17–19:57:51 之间，平均每 10~20 秒一次，多数是 `Bash` 与 `Edit` |

两个直接推论：

1. 一次「漏看」不是漏一条，而是漏一串——50s 超时一到就是连续 deny，Claude 开始绕路（9 号文档已经证明过绕路的代价）。
2. 提醒必须**去重 + 节流**：28 条不能弹 28 个 Windows 通知。

### 1.4 现状的四个具体毛病

| # | 场景 | 现在 | 后果 |
| --- | --- | --- | --- |
| P1 | 一条 run 连发请求 | 右栏 360px 堆卡片，正文变窄 | 看命令要来回滚，眼睛在右栏、手在正文 |
| P2 | 人在别的页 / 面板收起 | 只有侧栏一行小字 | 等于没提醒，50s 后自动拒绝 |
| P3 | 请求属于别的会话 | 卡片不标「当前在看哪条」 | 误批/误拒无法察觉 |
| P4 | 服务没起 / 面板没打开 | 记录停在 pending，MCP 到点 deny | 卡片永远不出现，也没有任何提示（回收逻辑在 server 里） |

### 1.5 漏批之后：会话页没有路

| 事实 | 位置 | 说明 |
| --- | --- | --- |
| 卡片只渲染 `status==="pending"` | `web/src/components/AuthRail.vue:8` | 记录一旦转成 `expired` / `rejected`，卡片**当场消失**，不留痕、不给任何动作 |
| 过期是自动发生的 | `server/approvals.mjs:208-214`（`expire`）、`:276-283`（超时先写 deny 再 expire）、`agent/approval-mcp.py:176-177`（MCP 侧超时） | 没人点 = 50s 后静默拒绝，run 带着「被拒」继续跑 |
| 会话页只能看，不能重跑 | `web/src/components/TerminalCard.vue:138-149` | 头部按钮只有 `标记完成 / 复制 / 全屏 / 删除` |
| 唯一的「再发一次」在任务页 | `web/src/components/TaskCard.vue:83-94` → `web/src/store/useTasks.ts:106-125` | `dispatchTask(t, cont)`：有 `sessionId` 走 `/api/task/continue`（续接同一会话），否则 `/api/task/dispatch`（新会话）；正文取 `drafts[id]` 或 `note` 或 `subject` |

**结论**：会话页看到「被拒了」之后，唯一出路是切到任务页、找到这条、点「发给 Claude Code（续接）」——而且只有你**知道**要去那儿才找得到。会话页本身没有任何「接着跑 / 再试一次」的入口。

### 1.6 「第 N 轮 / 动作」是前端造出来的一层

- 服务端只有一条**平的**流：`data/streams/<id>.jsonl`（`resolveRunFile`，`server/events.mjs:307-323`），SSE 推的也是平铺的 `{kind:"line", line:{kind,...}}`（`emitRaw`，`:535-547`）。
- 前端把它重建成「轮 + 动作」：`roundFor / applyLine`（`web/src/store/useTerminal.ts:135-175`）＋ `TerminalCard` 里的 `round-hd / round-bd / act-row` 模板，“每轮几动作/几文件”“异常提示”“搜索命中”全部挂在这一层（`web/src/utils/terminal.ts` 的 `roundStats / anomalies / roundMatches`）。
- 服务端其实**早就给得出平铺结果**：`linesFromRounds`（`events.mjs:355-373`）生成 `lines[]`，`/api/task/raw?v=2` 已随包返回；`/api/task/log` 也是事件流。

**结论**：简化 = 删掉前端这一层，**服务端契约不用改**；顺带把 1.7 里的“窗口覆盖”问题一起消掉。

### 1.7 提权期间「日志停住、得刷新」：症状确认为真，根因待复现

先排除一件事：**服务端不会因为授权等待而停推。** `streamLosflow`（`events.mjs:584-655`）每 700ms 重算 targets、按字节 offset 增量读文件，没有空闲超时、没有主动断开；授权等待期间 claude 进程本来就不产出新行，所以「没有新行」是正常的。我把 SSE 抓了 45s 验证过：连接稳定、`run reset` 后能补发尾部、断流只是因为没有新输出。

会把「看起来卡住、只能刷新」做出来的是前端的三处机制：

| # | 机制 | 位置 | 后果 |
| --- | --- | --- | --- |
| a | `run reset` 后 300ms 调 `loadRounds`，用服务端窗口**整体替换** `rounds[id]`（不是按 seq 合并） | `useTerminal.ts:181-188`、`:106-110` | 服务端从文件读到的窗口可能落后于刚 SSE 推来的几行 → 这几行被覆盖；要等下一次全量刷新才回来 |
| b | 用户往上滚过以后 `follow=false`，新行只累加 `pendingNew` 计数 | `useTerminal.ts:196-197`、`:216-233` | 授权卡出现/消失带来的布局变化不会重置 `follow`，画面看着停住，得点「↓ 底部」或刷新 |
| c | `raws` 只由 SSE 填充，没有 `onerror` / 重连逻辑；回填窗口只有最后 300 行 | `useLifecycle.ts:28-44`、`useTerminal.ts:190-195`、`events.mjs:622`（`slice(-300)`） | 断线（含浏览器冻结后台 iframe、服务重启）期间的行**永久缺失**，只能刷新重拉 ← 最像「得刷新」的那条 |

**复现步骤（约 3 分钟）**：开一条会撞权限的 run → 授权卡出现后**不点**，让它超时 → 看后续行是否照常到达；再把 DSH 窗口切后台 2 分钟切回来；两种结果记到本文档“变更记录”。

> 口径：**症状是杰哥实测的**，“三条机制”是代码里确实存在、但哪一条是主因要按上面步骤定；1.7 的整改不依赖定位结果——见 4.8 的三条硬约束。

---

## 2. 参考范式：DSH 自己的审批就是「对话的下边」

DSH 的 `@deepseek-ai/dsh-client-ui-approval` 包自述是 *"Approval composer takeover over the scoped Remote Event waterfall"*：待批时**接管 composer（输入框）位置**，卡片出现在会话底部，按钮是「允许一次 / 拒绝」，选完回到输入框（`src/client/ApprovalPanel.tsx`、`src/client/contract/slots.ts` 的 `conversation.composer` / `conversation.approval.card`）。

也就是说：杰哥想要的「对话的下边」，在 DSH 里已经是标准做法；LosFlow 只需对齐，不用发明新交互。

> 注意区分两条链路：DSH 那条是「沙箱工具要提权」，LosFlow 这条是「Claude Code 派单要提权」。本方案只改 LosFlow；如果 DSH 那条也要改，另开一条。

---

## 3. 目标 / 非目标

**目标**

1. 卡片出现在**对应会话**里：底部接管条（当前选中会话）+ 悬浮小卡（非当前选中 / 全屏态）。
2. 「会话」页取消常驻第三栏，终端拿回 360px。
3. 新请求 **≤1s** 出现在 UI（现有 SSE 已够，补「定位/跳转/队列」）。
4. **Windows 提醒**：新请求入队即弹（不管页面看不看得到），带声音；20s 未处理再响一次；可开关。
5. 批准/拒绝/记住规则的语义**一字不改**（live 同 run 继续；legacy/midRun 仍是写 allowlist + 重派）。
6. 漏批有出路：过期/被拒后 dock 留灰条 + 会话头部有「接着跑（续接）」，不用回任务页。
7. 会话详情 = **一条连续日志**；不再出现「第 N 轮 / 动作」。
8. 日志**自愈**：授权等待、SSE 断线、浏览器冻结后台、服务重启，都不需要手动刷新。

**非目标**

- 不做手机推送 / 远程审批。
- 不改 MCP 协议、不改 50s 超时（只改提示与展示；超时时长可另行讨论）。
- 不把审批塞进 DSH 的聊天区（那是 DSH 自己的 composer，跨插件改它风险大；Phase 3 可只做「DSH 标签页标题提示」）。
- 不改服务端 `/api/task/raw` 的既有字段（`rounds` / `lines` / `stats` / `end` 全保留），只在它上面**加**一个可选的 `after`。
- 不在页面里渲染原始 jsonl（单会话可达 11MB 级，继续走「原始日志」下载）。

---

## 4. 方案：位置

### 4.1 A（主）：`ApprovalDock.vue` —— 会话底部接管条

- **挂载点**：`TerminalCard` 内部、`.term-body` **之后**、`.jump` 之前（即「对话的下边」，滚动区外，永远可见）。`.term` 已经是 `position: relative`（`term.css:47`），不需要新定位上下文。
- **只显示当前选中会话的请求**：`pending.filter(a => a.taskId === task.id)`，FIFO 排序（按 `atMs`），不做优先级。
- **形态**（紧凑一行 + 可展开）：
  - 左：`AUTH` 脉冲点 + `1/3`（队列序号）+ `#9 run 1d757b`
  - 中：工具名 + 命令缩略（3 行，点击展开全文，`pre` + 等宽，纯文本，沿用 `cmdText()`）
  - 右：倒计时 `剩 32s` + 建议规则 chip（点击→「批准并记住」）+ 四个按钮：`只批这次` / `批准并记住` / `拒绝` / `终止`
- **样式**：直接复用 `.auth-card` / `.ac-*` 的配色（`term.css:157-168`），外层换成横向 flex，避免再画一套。
- **键盘**：`Ctrl+Enter` = 只批这次，`Ctrl+Backspace` = 拒绝（不用单键，防误触）。
- **队列切换**：`←` / `→` 只在 dock 获得焦点时生效；批准后自动跳到下一条。

### 4.2 B（辅）：`ApprovalFloat.vue` —— 悬浮在「对应会话」上

- **触发**：有 pending 请求**不属于**当前选中会话时（P3），或当前会话处于 `.term.full` 全屏态（此时 B 也接管当前会话的请求，避免全屏看不到 dock）。
- **位置**：`.term` 内 `position: absolute; right: 16px; top: 64px; width: 320px`，与 `.jump`（`term.css:49-55`）同一定位体系。
- **折叠态**：`⚠ AUTH 2` 胶囊（宽 ~110px），点击展开成卡片；卡片里带会话标题 + 「切过去」按钮 → `selectTask(taskId)`（`useTerminal.ts` 已有）。
- **去重**：同一 `id` 已在 dock 出现时，float 不再显示这一条。

### 4.3 其它入口

| 位置 | 改法 |
| --- | --- |
| `SessionList.vue:35` 行尾 | 该会话有 pending 时，`smeta` 前加一个 `⚠` 角标（`tone="warn"`），不用点进去也知道哪条被卡住 |
| `AppSidebar.vue:38-40` | 保留计数入口（全局唯一计数），文案改成 `AUTH 2 条等你批（#9 #12）` |
| `TerminalsView.vue` | 删 `<AuthRail>`、删 `with-rail`（`:84`、`:95`）、删 `pending` 计算（`:22`，若不再用于布局） |
| `AuthRail.vue` | 不删：降级成「历史/全量授权记录」面板，放进设置页或会话页的折叠区（20 条历史还需要一个查看入口） |

### 4.4 布局与样式改动（`term.css`）

```css
/* 删：.term-grid.with-rail（:72）与 @media(max-width:1100px) 里的 with-rail 分支（:169-172） */
.term-grid { grid-template-columns: 300px minmax(0, 1fr); }        /* 回到两栏 */

.auth-dock { border-top: 1px solid #3a2a12; background: #140f08; padding: 10px 16px; }
.auth-dock.stuck { position: sticky; bottom: 0; z-index: 6; box-shadow: 0 -8px 24px rgba(0,0,0,.5); }
.auth-float { position: absolute; right: 16px; top: 64px; width: 320px; z-index: 7; }
@media (max-width: 560px) { .auth-float { left: 12px; right: 12px; width: auto; } }
```

- `.term.full`（`:32`）是 flex 列，dock 自然落在 `.term-body` 下面，全屏也可见——这也是 B 在全屏下仍要顶上的原因（全屏时 `.term-body` 撑满，dock 可能被挤到视口外）。
- `.jump` 与 dock 同时出现时，`bottom` 让位给 dock（dock 高度 ~44px 时 `.jump { bottom: 56px }`）。

### 4.5 前端数据流（授权这部分尽量不动 store）

- `useLifecycle.ts` 已有「收到 approval SSE → refresh」和「有 live 时 1s 轮询」（`:15-26`），**保持不变**。
- 新增一组纯函数（放 `web/src/utils/approvals.ts`）：`pendingOf(state, taskId)`、`queueIndex(list, id)`、`summaryOf(rec)`、`mergeLines(a, b)`，dock/float/sessionlist/日志共用，避免各处各写一遍。
- `types.ts:83-110` 的 `Approval` 已含 `taskId/live/midRun/expiresAt`，不用改；若要标「已提醒过」再加 `notifiedAt`（可选）。

### 4.6 C：漏批恢复 —— 「接着跑」不用回任务页

1. **dock 不消失**：请求过期/被拒后，卡不删，转成灰条（保留 30 分钟或到下一次 run 开始）：
   `已过期：这次调用按拒绝执行（19:58:41）` + `[接着跑（续接）] [放弃]`
2. **会话头部兜底按钮**：`TerminalCard` 在 `!isRunning` 且（`run.status !== "ok"` 或最近一次授权是 `expired`/`rejected`）时显示 `接着跑`。
3. **实现复用现成的**：两者都调 `dispatchTask(task, true)`（`useTasks.ts:106-125`）——有 `sessionId` 走 `/api/task/continue`，Claude 记得上一段上下文；`drafts[id] || note || subject` 取正文，不需要人再打字。
4. **环境变了**：`useTasks.ts:117` 已有 `newSession` 分支（跨 WSL/Windows 不能续接），会提示「已新开会话」，不用另写。
5. **规则已经记住时**：上一轮点过「批准并记住」→ allowlist 有规则 → 续接后同一命令直接过，不再二次提权。
6. 任务页保持现状，不重复造按钮。

### 4.7 D：会话详情改成一条连续日志

**做什么**

- 首屏：`/api/task/raw?v=2` 的 `lines[]`（`events.mjs:355-373`）按 `seq` 灌进 `raws[id]`；增量继续走 SSE 的 `line`（已有）。
- 渲染：一张平铺等宽列表，按行 kind 着色——`think` 暗色斜体 / `say` 正文 / `cmd` `$` 前缀高亮 / `out` 灰 / `err` 红 / `end`、`report` 分隔线；单行 >2000 字符或整段 >400 行折叠「展开」。
- 保留：搜索高亮（`HighlightText`）、`只看错误 / 只看命令 / 只看改动`（改成按行 kind + `input` 判断，`cmd` 行已带 `tool/input`，见 `events.mjs:544`）、复制、`原始日志` 下载、跟随到底。
- 删掉：`第 N 轮`、`动作` 行、`round-hd/round-bd/act-row`、`roundStats / anomalies / roundMatches`；异常提示改成两个角标：`N 条错误`、`N 分钟无输出`。
- 顶部条保留：任务号/标题/环境/耗时/花费/结束状态 —— 这些是“会话级信息”，不是“轮级信息”。

**收益**：`useTerminal.ts` 约 −120 行、`TerminalCard.vue` 约 −80 行；1.7-a 的“窗口覆盖”问题随 `rounds` 一起消失；`/api/task/raw` 的 `rounds` 仍可保留给 mark/验收（`useMark` 用 `summary`，不冲突）。

### 4.8 日志必须自愈：三条硬约束

| 约束 | 做法 |
| --- | --- |
| **只追加、不整体替换** | `raws[id]` 按 `seq` 合并去重；`run reset` 清空后重新回填也走同一个合并函数；服务端 `/api/task/raw` 增加可选 `after=<seq>`，回填只补缺的部分 |
| **断线自愈** | `EventSource.onerror` → 3s 后重建连接；重建成功立刻做一次 `after=<最后 seq>` 对账；`document.visibilitychange` 回到前台时也做一次 |
| **空窗要显式化** | 授权等待期间在日志尾部插一行「等待人工授权（剩 Ns）」，让人知道不是卡死；`lastEventAt`（`useTerminal.ts:194`）已有，直接复用 |

**硬性口径：任何路径都不允许“要刷新才继续”**——SSE 断、浏览器冻结、服务重启、授权等待 50s 全过期，都要能自己接上（验收第 13 条）。

---

## 5. 方案：Windows 提醒

### 5.1 触发点（服务端，不依赖浏览器是否开着）

| 触发 | 位置 | 说明 |
| --- | --- | --- |
| 新 live 请求入队 | `server/approvals.mjs:236-240` | `notify("waiting", next)` 之后调 `notifyApproval(next)` |
| midRun 兜底入队 | `server/approvals.mjs:445` | 同上（降级 C 的路径） |
| 超时/过期（可选，默认关） | `approvals.mjs:276-283` | 一条轻提示「已按超时拒绝」，让人知道刚才漏了什么 |

**明确不触发**：`approved` / `rejected`（人的动作，不需要再吵）。

### 5.2 本机实测（2026-11-13 20:0x，Windows 11 25H2 build 26100 / PowerShell 5.1.26100.9818）

| 方式 | 结果 | 证据 |
| --- | --- | --- |
| WinRT `ToastNotificationManager.CreateToastNotifier(AUMID)` | ❌ `Exception from HRESULT: 0x80073D54` —— *The process has no package identity* | `_scratch/toast-test.ps1` |
| `System.Windows.Forms.NotifyIcon.ShowBalloonTip` | ✅ 返回成功，桌面弹出通知（Win10+ 由系统渲染成 toast 样式） | `_scratch/balloon-test.ps1` |
| BurntToast 模块 | 未安装（`Get-Module -ListAvailable` 为空） | — |
| `msg.exe` | 不存在 | `Test-Path` false |

**结论：默认走 `NotifyIcon` 气球**（无依赖、无管理员、无打包要求）；WinRT toast 作为以后「注册 AUMID + COM 激活器」的可选升级，不阻塞本次。

### 5.3 实现

```
server/notify.mjs                      ← 编排：去重/节流/重复/降级/状态
  └─ spawn powershell.exe -File agent/win-notify.ps1 -PayloadB64 <base64-json>
       ├─ 先试 NotifyIcon 气球（默认）
       ├─ 失败 → SystemSounds.Exclamation 蜂鸣（保证至少有声音）
       └─ 退出码/输出写回 server 日志；连续失败 3 次 → notify.ok=false
```

- **为什么用 `-PayloadB64`**：本次踩到的真坑——用 `powershell.exe -File x.ps1` 跑**含中文的 UTF-8 无 BOM 脚本**会解析失败（`Missing ')' in function parameter list`）或乱码。所以脚本本体**只写 ASCII**，中文标题/命令摘要由 Node 侧 `JSON.stringify` → base64 传入，PS 里 `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))`。
- **进程开销**：每次提醒 spawn 一个 powershell.exe（约 200–400ms）。有 8s 节流，一条 run 最多弹几次；Phase 2 可换常驻小守护（监听 `data/notify/queue/`）。
- **必须在登录会话里跑**：server 若做成 Windows 服务（session 0），气球不会出现在桌面上——`runbook.md` 要写明「用 `npm start` 在登录会话里跑」。

### 5.4 提醒内容

| 字段 | 例子 | 说明 |
| --- | --- | --- |
| 标题 | `LosFlow · AUTH 1 条等你批` | 固定前缀，便于在通知中心一眼认出 |
| 第一行 | `#9 请你阅读 Vesta 项目…` | 会话标题截断 24 字 |
| 第二行 | `Bash · npm run verify · 剩 45s` | 工具 + 命令**摘要**（首个 token/前 40 字），不放全文（命令可能很长、含敏感值） |
| 声音 | `SystemSounds.Exclamation` | 与通知分离：专注助手吞掉通知时，声音还在 |

### 5.5 去重 / 节流 / 重复

```js
// notify.mjs 的内存表
seen: Map<approvalId, {at, count}>   // 同一 id 只响一次（重复响由 repeat 管）
lastAt: number                       // 全局节流：minIntervalMs（默认 8000）
repeat: Map<approvalId, timer>       // repeatAfterMs（默认 20000）后再响一次，带「剩 Ns」
```

- 同一 run 28 条请求：首条立刻响，后续 8s 内的合并成「AUTH 3 条等你批」（标题计数随队列变化）。
- 到期（`expiresAt`）后清 timer，不再响。
- 配置 `notify.minIntervalMs=8000`、`notify.repeatAfterMs=20000` 可调；`0` 关闭。

### 5.6 点击行为（明确说清能做到什么）

- 气球点击 = 收起，**无法带链接**（Windows 对未打包应用的限制）。
- WinRT toast 想做到「点开面板」，需要 AUMID 注册 + COM 激活器，而本机连 `CreateToastNotifier` 都过不去（5.2），所以**本期不做点击跳转**。
- 折中：通知标题里带计数，人扫一眼就知道要不要回来看；页面内再靠 dock / 角标 / 侧栏计数闭环。

### 5.7 服务端状态可见

`/api/state` 增 `notify: { enabled, ok, mode, lastAt, lastError }`；前端在设置页显示一行「Windows 提醒：开 / 关 / 不可用（原因）」。**没有这一行，人会把「没弹」误判成「没请求」。**

---

## 6. 改动清单

| 文件 | 改什么 | 估算 |
| --- | --- | --- |
| `web/src/components/ApprovalDock.vue` | **新增**：底部接管条（队列、倒计时、四按钮、展开命令） | 180 行 |
| `web/src/components/ApprovalFloat.vue` | **新增**：悬浮卡 / 折叠胶囊 + 「切过去」 | 110 行 |
| `web/src/views/TerminalsView.vue` | 删 `AuthRail` 与 `with-rail`，网格回两栏 | -10 行 |
| `web/src/components/TerminalCard.vue` | ① `.term-body` 后挂 `<ApprovalDock>`，`.jump` 让位；② 删「轮 / 动作」模板 → 平铺日志（4.7）；③ 头部加「接着跑」 | +25 / −80 行 |
| `web/src/components/SessionList.vue` | 行尾 `⚠` 角标 | +6 行 |
| `web/src/components/AppSidebar.vue` | 计数文案带会话号 | +2 行 |
| `web/src/components/AuthRail.vue` | 降级为历史列表（挪进设置/折叠区） | 约不变 |
| `web/src/store/useTerminal.ts` | 删 `rounds` 重建层；`raws` 按 `seq` 合并、`onerror` 重连、`visibilitychange` 对账（4.8） | +40 / −120 行 |
| `web/src/utils/terminal.ts` | 删 `roundStats` / `roundMatches`，`anomalies` 只留「N 分钟无输出」 | −60 行 |
| `web/src/term.css` | 删 `with-rail` 两个分支；新增 `.auth-dock` / `.auth-float` / 平铺日志行样式 | +40 行 |
| `web/src/utils/approvals.ts` | **新增**：`pendingOf` / `queueIndex` / `summaryOf` / `mergeLines` | 60 行 |
| `server/events.mjs` | `readRunRounds` 增可选 `after=<seq>`（只返回该 seq 之后的行） | +15 行 |
| `server/server.mjs` | `/api/task/raw` 透传 `after`；`/api/state` 加 `notify`；启动时 `notify.init()` | +14 行 |
| `server/notify.mjs` | **新增**：编排、去重、节流、重复、降级、状态 | 160 行 |
| `agent/win-notify.ps1` | **新增**：ASCII 脚本，气球 + 蜂鸣，读 `-PayloadB64` | 60 行 |
| `server/approvals.mjs` | 两处入队后调 `notifyApproval`；可选超时通知 | +8 行 |
| `losflow.config.example.json` | `notify: {enabled, mode, sound, minIntervalMs, repeatAfterMs}` | +7 行 |
| `docs/api.md` | `/api/state` 新增 `notify` 字段；`/api/task/raw` 新增 `after` 参数 | — |
| `README.md` | 流程图「右侧授权栏当场批准」→「会话底部当场批准 + Windows 提醒」；「第 N 轮」文案改成连续日志 | — |
| `docs/architecture.md` | 会话页布局（两栏 + dock/float）、`approvals.mjs` 职责加「通知」、会话详情「平铺日志」 | — |

---

## 7. 验收标准

1. 派一条会撞权限的 run：**≤1s**，当前会话底部出现接管条，含 `#task / run / 工具 / 命令 / 建议规则 / 倒计时`。
2. 点「只批这次」：同一次 run 继续执行该命令（回执 `permission_denials` 不含它，台账仍只有一条 run），dock 自动切到队列下一条。
3. 点「拒绝」：该 `tool_result` 带拒绝语，run 继续，不重派。
4. 请求属于**另一个会话**时：当前会话出现悬浮卡，点「切过去」选中该会话后 dock 显示这条；同一 id 不会同时出现在 dock 和 float。
5. 「会话」页不再有第三栏；终端宽度比现在多 360px；`<1100px` 面板下不再出现"整段会话下方最后一块"的卡片。
6. 把面板收起 / 浏览器最小化，再触发一次请求：**1s 内**看到 Windows 通知 + 听到提示音；20s 不处理再响一次（带剩 N 秒）；点批准后不再响。
7. 28 连发场景：通知间隔 ≥8s，dock 队列按 FIFO、不丢不重（对照 `data/approvals.json` 条数）。
8. `notify.enabled=false` 或非 Windows：不弹、不报错，`/api/state.notify.ok=false` 且设置页显示「已关闭」。
9. `npm run smoke` / `npm run build` / `npm run typecheck` 绿。
10. 历史 `approvals.json`（含 legacy / midRun 记录）仍能正常显示在历史面板里。
11. 授权过期后：dock **不消失**，转灰条；点「接着跑（续接）」→ 新台账一条 run 且 `session` 与上一条相同（同一会话续接），日志从当前尾部继续出；「放弃」才收起。
12. 会话详情里**不再出现**「第 N 轮 / 动作」；整段是一条连续日志，搜索高亮、只看错误/命令/改动、复制、原始日志下载都还能用。
13. **不需要刷新**：① 授权卡挂着不点、50s 全过期期间与之后，后续行照常到达；② 把 DSH 窗口切后台 2 分钟再切回，缺的行自动补上；③ 手动 `taskkill` 掉 server 再用 `npm start` 起回来，页面能自己接上（不 F5）。
14. 平铺日志下 3000 行上限（`useTerminal.ts:193`）仍生效，超出后顶部丢弃、可「加载更早」。

---

## 8. 风险与待确认

| # | 风险 / 待定 | 说明与倾向 |
| --- | --- | --- |
| R1 | 气球通知在 Win11 25H2 的真实观感 | 实测「调用成功」，但样式是 toast 还是老气球、会不会进通知中心，需要一次真机目视确认（本次只能确认不抛错） |
| R2 | server 在 session 0（服务化）时提醒失效 | 文档写明必须在登录会话里跑；`notify.ok` 自检可发现 |
| R3 | 每次提醒 spawn powershell.exe | 有 8s 节流，实测可接受；Phase 2 换常驻守护进程 |
| R4 | dock 的吸底方式 | `.term-body` 自带 `overflow:auto`（`term.css:29`），dock 在其外，正常文档流即可；若页面滚动导致 dock 跑出视口，再加 `position: sticky`（`.auth-dock.stuck`） |
| R5 | 悬浮卡在窄 iframe（<520px） | 改成折叠胶囊，默认只显示「⚠ AUTH 2」 |
| R6 | 键盘快捷键与浏览器/DSH 冲突 | 只用 `Ctrl+` 组合；焦点在输入框时不拦截 |
| R7 | 50s 超时是否要放宽 | 加了提醒之后，50s 仍可能不够（人离开座位）。建议同批把配置项 `approvalTimeoutSec` 提到 90–120s 前先确认 MCP 工具调用上限（9 号文档 R2 仍未验证）；**本条单独定，不混进位置改动** |
| R8 | 是否也提醒 DSH 自己的审批 | 两条链路不同，需杰哥确认；本方案不含 |
| R9 | 历史面板保留在哪 | 倾向：设置页「授权记录」+ 会话页顶部折叠，避免第三次改动位置 |
| R10 | 删掉「轮」之后「只看改动」怎么判 | 现在靠 `isChangedTool(tool,input)`；平铺 `cmd` 行仍带 `tool/input`（`events.mjs:544` 存过 `actions`），可行；若丢了 `input` 就退回「只看 Edit/Write 文件名」 |
| R11 | `/api/task/raw` 加 `after` 的兼容 | 新参数可选，老前端不传照旧；`smoke` 里加一条「带 after 只返回更晚的行」 |
| R12 | 3000 行上限 + 平铺后信息密度变高 | 折叠长行（>2000 字符）、超 400 行懒展开；「加载更早」沿用现有 `before` 窗口 |
| R13 | 「接着跑」可能重复花钱 | 按钮要带确认（复用 `askConfirm`），且 `isRunning` 时禁用；与「终止」同一条护栏 |

---

## 9. 实施顺序与预估

| 步 | 内容 | 预估 |
| --- | --- | --- |
| 1 | 前端位置：`ApprovalDock` + `ApprovalFloat` + 角标 + 删右栏（先本地跑通，不碰服务端） | 0.5 天 |
| 2 | 会话详情平铺：删轮/动作、`raws` 合并与自愈、`after` 参数、「接着跑」入口 | 0.5 天 |
| 3 | `notify.mjs` + `win-notify.ps1`：气球 + 声音 + 去重/节流/重复 + `notify` 状态 | 0.5 天 |
| 4 | 真机联调：撞权限 → 通知 → 点批准 → 同 run 继续；漏批 → 接着跑；切后台 2 分钟回来对账；28 连发压一遍 | 0.5 天 |
| 5 | 文档：`docs/api.md` / `README.md` / `docs/architecture.md` / `runbook.md`（登录会话要求） | 0.2 天 |

**合计约 2.2 天**；第 1 步单独就能解决「侧边提权」这条，可以先合；第 2 步依赖第 2 步之外的改动最少，可独立合入。

---

## 变更记录

- 2026-11-13 初稿：现状核对（11 个环节的代码行 + 真机 28 条请求的等待分布）、四个具体毛病、DSH composer takeover 参考、方案 A（底部接管条）/ B（悬浮卡）、Windows 提醒选型（WinRT toast 实测 `0x80073D54` 不可用 → `NotifyIcon` 气球可用）、中文编码坑（base64 传参）、验收 10 条与风险 9 条。
- 2026-11-13 追加（杰哥同日晚间补充三条现状）：
  - **漏批即死路**：确认 `AuthRail.vue:8` 只渲染 pending、过期记录直接消失；会话页无任何重跑入口，唯一的续接在任务页 `TaskCard.vue:83-94` → `dispatchTask`（`useTasks.ts:106-125`）。方案见 4.6（dock 留灰条 + 「接着跑（续接）」）。
  - **「第 N 轮 / 动作」是前端造的一层**：服务端只有平铺流（`resolveRunFile` / `emitRaw`），且已产出 `lines[]`（`events.mjs:355-373`）；简化即删前端 `rounds` 层，服务端契约不动。方案见 4.7。
  - **提权期间日志停住、要刷新**：症状采信；实测 SSE 45s 无中断（服务端 `streamLosflow` 无空闲超时），定位到前端三处机制（`useTerminal.ts:106-110/181-188` 窗口覆盖、`:196-197` follow 关闭、`useLifecycle.ts:28-44` 无重连且 `raws` 只由 SSE 填）。方案见 4.8 + 验收 13，根因以复现步骤定。
  - 验收 +4 条（11–14）、风险 +4 条（R10–R13）、实施 +1 步（2.2 天）。

- 2026-11-13 实施（A + B + C + D + Windows 提醒）：
  - **位置 A/B**：新增 `web/src/components/ApprovalDock.vue`（当前会话底部接管条：队列序号、倒计时、命令展开、四按钮、`←/→` 与 `Ctrl+Enter`/`Ctrl+Backspace`）与 `ApprovalFloat.vue`（其他会话 / 全屏时悬浮卡 + 「切过去」）；`TerminalsView` 删除第三栏与 `with-rail`，网格回到两栏；`SessionList` 加 `⚠ N` 角标；`AppSidebar` 计数带会话号；`AuthRail` 降级为设置页「授权记录」（含已处理记录）。
  - **C 漏批恢复**：`TerminalCard` 头部在 `!isRunning` 且最近 run 非 ok / 最近授权过期或拒绝时显示「接着跑」，复用 `POST /api/task/continue`（确认后执行，不新开会话）。
  - **D 平铺日志**：`useTerminal` 改为 `lines` 单一数据源，按 `seq` 合并（3000 行上限）；`utils/terminal.ts` 新增 `buildLogRows/logStats/rowMatches/logAnomalies`，`cmd/out/err` 按 `actionId` 归并；删除「第 N 轮 / 动作」UI；搜索、只看改动/错误/命令、复制、原始日志下载保留。
  - **日志自愈**：`/api/task/raw?v=2` 的 `lines[]` 带 `seq`（文件字节偏移派生），新增 `after` / `beforeSeq` / `hasEarlier` / `firstSeq` / `lastSeq`；SSE 的 seq 与 HTTP 回填同一套编号；`useLifecycle` 增加 `onerror` 3s 重连、`onopen` 与 `visibilitychange` 对账；`run reset` 清空后按需回填。
  - **Windows 提醒**：新增 `server/notify.mjs`（8s 节流合并、20s 未处理再响、去重、失败降级、`/api/state.notify` 状态）与 `agent/win-notify.ps1`（ASCII + base64 中文，`NotifyIcon` 气球 + 声音）；`approvals.mjs` 在 live / midRun 入队时触发，批准/拒绝/过期时清定时器；`paths.mjs` 与 `losflow.config.example.json` 增加 `notify`。
  - **其他**：`settings` 页显示 Windows 提醒状态与授权记录；`docs/api.md` / `docs/architecture.md` / `README.md` / `docs/runbook.md` / `web/wiki.md` 同步；smoke 新增 `notify`、平铺日志、`after` 契约检查。
  - 验证：`npm run typecheck` / `npm test`（16）/ `npm run build` / `npm run smoke`（含新契约）全绿；临时数据目录实测 live 请求入队 → 系统通知（`notify.ok=true`）→ 批准同 run 继续；`win-notify.ps1` 单独执行返回 0；真实流上 `lines`/`after`/`beforeSeq` 生效。
  - 未做：R7（50s 超时放宽）、R8（DSH 自身审批提醒）、WinRT toast 点击跳转（未打包进程不支持）；气球观感需真机目视确认。

- 2026-11-13 调整（交互反馈）：
  - **位置改为右上悬浮**：按实际使用反馈，授权卡从「会话底部接管条」改为**会话右上悬浮覆盖层**（`position:absolute`，不占文档流），避免页面滚动与 `.term-body` 局部滚动互相干扰；当前会话请求排最前，其他会话排后并可「切过去」；`ApprovalFloat` 合并进 `ApprovalDock` 后删除。
  - **快捷键全局化**：`Ctrl+Enter`（只批这次）/ `Ctrl+Backspace`（拒绝）改为 window 级监听，不需要先点击卡片；焦点在输入框/可编辑区域时不拦截。`←/→` 仍在卡片获得焦点时切队列。
  - **会话展开按单个会话**：会话页删除全局「收起详情」按钮；点击会话行切换该会话的展开/收起（非当前行点击则切换并展开），状态按会话 id 持久化，`c` 切换当前会话。
