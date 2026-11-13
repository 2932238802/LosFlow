# HTTP 接口

所有 POST 都要带请求头 `x-dash: 1`（本地 CSRF 挡板）。返回统一为 `{ ok: true, result }` 或 `{ ok: false, error }`（HTTP 400）。

## 只读（GET）

| 路径 | 说明 |
| --- | --- |
| `/api/state` | 全部状态：`now / tasks / pool / docsync / approvals / allowlist / terminals / history / projects / running / calls / spendToday`；`tasks[]` 带 `docOnly`（文档同步类任务，不进任务页/终端页）、`starting`（已投递、子进程未接管）、`running`（这张卡自己的活会话 runId）；`tasks[].run` 只带 `id/at/status/cost/turns`，回执全文走 `/api/task/run` |
| `/api/docsync` | 文档同步队列摘要 |
| `/api/task/raw?id=<taskId>` | 某任务的终端行（`think/cmd/out/err/say/end/report`）+ 对应 runId（SSE 覆盖不到时的一次性回放） |
| `/api/task/raw?id=<taskId>&v=2` | **轮 + 动作契约**：`{dispatch,source,running,truncated,hasMore,totalRounds,stats,rounds[],end,lines[]}`。`source` 依次尝试 `archive`（`data/streams/<id>.jsonl`）→ `wsl`（`/tmp/cc-<id>.stream.jsonl`）→ `missing`；默认最后 40 轮，`&before=<round.i>` 往前翻；单响应 ≤ 2 MB；`lines[]` 保留旧平铺格式 |
| `/api/task/stream?id=<taskId>` | 下载这条会话的原始 stream-json（`data/streams` 或 WSL `/tmp`），不做解析；找不到返回 404 |
| `/api/task/log?id=<taskId>` | 某任务最近一次派单的事件流 |
| `/api/task/run?id=<taskId>` | 某任务最近一次派单的轻量元信息 + 回执全文 `result` + 规则摘要 `summary`（文件/动作/错误/轮次，供「标记完成」预填证据） |
| `/api/templates` | 拆分/优化用的提示词模板 |
| `/api/wsl/ls?path=~` | 浏览 WSL 目录（选项目 / 改工作目录用） |
| `/events/losflow` | SSE：**一条**多路复用终端流，消息体带 `taskId`：`run{reset}` / `line{seq,line}` / `end` |
| `/events/claude` | SSE：tail 最新 stream-json（旧接口，保留一版兼容） |
| `/events/workbuddy` | SSE：tail `calls.jsonl` |
| `/app/` | 前端 SPA |
| `/wiki` | 驾驶舱说明页（`web/wiki.md`） |

## 写（POST）

| 路径 | body | 说明 |
| --- | --- | --- |
| `/api/pool/add` | `{title,note,kind,project,type}` | 加入池子 |
| `/api/pool/toggle` | `{id,field}` | 细则/流程/授权开关 |
| `/api/pool/suggest` | `{id,prompt}` | 让 Claude Code 拆子任务 |
| `/api/pool/apply` | `{id,subs}` | 落拆分结果 |
| `/api/pool/push` | `{id,priority}` | 推入：任务落库 + 文档入队；授权打勾则自动派单 |
| `/api/pool/remove` | `{id}` | 删池子条目 |
| `/api/task/dispatch` | `{id,task,mode,allow}` | **投递型**：立刻返回 `{started:true,taskId}`，后台跑；有 sessionId 则续接；`docOnly` / 文档操作指令直接 400；同一任务已在启动中再点 → 400（防重复花费） |
| `/api/task/continue` | `{id,task}` | 续接上次会话；同样异步返回、拒绝 `docOnly` |
| `/api/task/split` / `/api/task/optimize` | `{id,...}` | 拆分建议 / 生成 SKILL.md（取结果型，仍阻塞等结果） |
| `/api/task/note` / `/api/task/repo` / `/api/task/delete` | `{id,...}` | 改备注 / 改目录 / 删任务 |
| `/api/task/status` | `{id,status,workType?,area?,evidence?}` | 人工验收：`done` 写 `status/workType/area/evidence/finishedAt` 并给腾讯文档入队一条 `update-row` 回填；`todo` 重新打开（证据保留） |
| `/api/task/nudge` | `{id}` | 生成催办文案（仅写时间戳，不通知 WB） |
| `/api/prompt/optimize` | `{text,taskId}` | 把草稿改写成派单指令 |
| `/api/run/stop` | `{taskId}` | 终止**这张卡自己的**派单：服务端按活进程反查 runId；不带 taskId 时沿用旧行为（running.json 里那条） |
| `/api/run/delete` | `{id,taskId}` | 删单次会话：WSL 产物 + runs 归档 + 台账行 + 会话指针 |
| `/api/docsync/report` | `{id,status,evidence}` | 文档同步回调（`done`/`failed`） |
| `/api/approve` / `/api/reject` | `{id}` | 授权批准（写 allowlist + 重派一次）/ 拒绝 |
| `/api/maintenance/purge` | `{hours}` | 清 N 小时前的 runs 与 WSL `/tmp/cc-*` |
| `/api/maintenance/config` / `/api/maintenance/cleanup` | — | 自动整理阈值 / 整理主表**入 docsync 队列**（`action:"cleanup"`，不建任务） |
| `/api/projects/add` / `/api/projects/remove` | `{name,path}` / `{id}` | 项目列表 |

## MCP（WorkBuddy 侧，stdio）

`agent/wb-bridge/server.mjs` 暴露：`list_tasks`、`next_task(owner)`、`report_task(id,status,evidence)`、`next_docsync`、`report_docsync(id,status,evidence)`、`add_task`。

- `next_docsync` 的动作：`append-row`（追加一行）/ `update-row`（回填已有行）/ `cleanup`（整理主表）。
- `add_task` 命中腾讯文档操作指令时**拒绝建任务**，提示走文档同步队列。
- `next_task` 跳过 `docOnly` 任务。
