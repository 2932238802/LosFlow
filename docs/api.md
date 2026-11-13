# HTTP 接口

所有 POST 都要带请求头 `x-dash: 1`（本地 CSRF 挡板）。返回统一为 `{ ok: true, result }` 或 `{ ok: false, error }`（HTTP 400）。

## 只读（GET）

| 路径 | 说明 |
| --- | --- |
| `/api/state` | 全部状态：`stage / tasks / pool / docsync / approvals / allowlist / terminals / history / projects / running / dispatches / spendToday` |
| `/api/docsync` | 文档同步队列摘要 |
| `/api/task/raw?id=<taskId>` | 某任务的终端行（`think/cmd/out/err/say/end/report`）+ 对应 runId |
| `/api/task/log?id=<taskId>` | 某任务最近一次派单的事件流 |
| `/api/templates` | 拆分/优化用的提示词模板 |
| `/api/wsl/ls?path=~` | 浏览 WSL 目录（选项目用） |
| `/events/claude` | SSE：tail 最新 stream-json |
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
| `/api/task/dispatch` | `{id,task,mode,allow}` | 派单（有 sessionId 则续接） |
| `/api/task/continue` | `{id,task}` | 续接上次会话 |
| `/api/task/explore` | `{id}` | 只读探索 |
| `/api/task/split` / `/api/task/optimize` | `{id,...}` | 拆分建议 / 生成 SKILL.md |
| `/api/task/note` / `/api/task/repo` / `/api/task/delete` | `{id,...}` | 改备注 / 改目录 / 删任务 |
| `/api/task/nudge` | `{id}` | 生成催办文案（仅写时间戳，不通知 WB） |
| `/api/prompt/optimize` | `{text,taskId}` | 把草稿改写成派单指令 |
| `/api/run/stop` | — | 终止当前派单 |
| `/api/run/delete` | `{id,taskId}` | 删单次会话：WSL 产物 + runs 归档 + 台账行 + 会话指针 |
| `/api/docsync/report` | `{id,status,evidence}` | 文档同步回调（`done`/`failed`） |
| `/api/approve` / `/api/reject` | `{id}` | 授权批准（写 allowlist + 重派一次）/ 拒绝 |
| `/api/maintenance/purge` | `{hours}` | 清 N 小时前的 runs 与 WSL `/tmp/cc-*` |
| `/api/maintenance/config` / `/api/maintenance/cleanup` | — | 自动整理阈值 / 建整理任务 |
| `/api/projects/add` / `/api/projects/remove` | `{name,path}` / `{id}` | 项目列表 |

## MCP（WorkBuddy 侧，stdio）

`agent/wb-bridge/server.mjs` 暴露：`list_tasks`、`next_task(owner)`、`report_task(id,status,evidence)`、`next_docsync`、`report_docsync(id,status,evidence)`、`add_task`。
