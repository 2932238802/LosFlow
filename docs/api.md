# HTTP 接口

所有 POST 都要带请求头 `x-dash: 1`（本地 CSRF 挡板）。返回统一为 `{ ok: true, result }` 或 `{ ok: false, error }`（HTTP 400）。

## 只读（GET）

| 路径 | 说明 |
| --- | --- |
| `/api/state` | 全部状态：`now / tasks / pool / docsync / approvals / allowlist / notify / terminals / history / projects / running / calls / spendToday / defaultEnv`；`tasks[]` 带 `docOnly`（文档同步类任务，不进任务页/终端页）、`starting`（已投递、子进程未接管）、`running`（这张卡自己的活会话 runId）、`env`（解析后的 `wsl`/`windows`）、`envMode`（`auto`/`wsl`/`windows`）、`sessionEnv`、`lastError`（最近一次 preflight / 失败原因）；`tasks[].run` 只带 `id/at/status/env/cost/turns`（`cost` 缺失时为 `null`），回执全文走 `/api/task/run`；`projects[]` 带 `env`（模式）与 `resolvedEnv`；`terminals.items[]` 带 `env`；`approvals[]` 带 `live`（执行前实时请求）/ `midRun`（已发生的拒绝）/ `runId` / `taskId` / `tool` / `expiresAt` / `waitedMs`；`notify` 是 Windows 提醒状态 `{enabled,ok,mode,lastAt,lastError}`；`connectors[]` 是连接器列表 + `enabled/target/mapping/actions/queue/health/queueStats`（不返回密钥） |
| `/api/job?id=<jobId>` | 单个后台作业：`{id,kind,key,label,status,at,startedAt,doneAt,elapsedMs,result?,error?,cost?,via?}`；`status` = `running` / `ok` / `failed`。用于拆分等长动作的轮询，结果全文在 `result` |
| `/api/jobs?kind=<kind>` | 作业列表（默认最近 200 条，按 `at` 倒序）。池子行徽标用；`kind=pool.suggest` 即拆分作业 |
| `/api/docsync` | 文档同步队列摘要：`{pending,running,done,failed,byConnector,byTask,recent}`；每个 job 带 `connector/connectorKind/action/targetSnapshot/queue` |
| `/api/connectors` | `GET`：`{connectors:[...]}`；`POST {id,enabled?,target?,mapping?,actions?,match?,queue?,secret?,clearSecret?}`：保存连接器配置（写 `data/connectors.json`；密钥写 `data/secrets.json`，永不回显） |
| `/api/connectors/test` | `{id}`：入队一条 `probe`（executor 交给外部 agent，direct 立刻执行） |
| `/api/connectors/replay` | `{id?}`：把 failed 的同步改回 pending（按连接器过滤；不传=全部） |
| `/api/task/raw?id=<taskId>` | 某任务的终端行（`think/cmd/out/err/say/end/report`）+ 对应 runId（SSE 覆盖不到时的一次性回放） |
| `/api/task/raw?id=<taskId>&v=2` | **平铺日志契约**：`{dispatch,source,running,truncated,hasMore,hasEarlier,firstSeq,lastSeq,totalRounds,stats,rounds[],end,lines[]}`。`source` 依次尝试 `archive`（`data/streams/<id>.jsonl`）→ `wsl` / `windows`（runstate 里记录的在跑流）→ `wsl`（旧 `/tmp/cc-<id>.stream.jsonl`）→ `missing`；`lines[]` 每条带 `seq`（文件字节偏移派生，HTTP 与 SSE 同一套编号）/`kind`/`tool`/`input`/`ok`/`actionId`；`&after=<seq>` 只返回更晚的行（断线对账），`&beforeSeq=<seq>` 往更早翻；默认保留最新窗口，`hasEarlier` 表示还能往前翻；单响应 ≤ 2 MB；`rounds[]` 保留给验收/摘要兼容；`end.cost` 缺失时为 `null`（前端显示「—」） |
| `/api/task/stream?id=<taskId>` | 下载这条会话的原始 stream-json（`data/streams`、runstate 或 WSL `/tmp`），不做解析；找不到返回 404 |
| `/api/task/log?id=<taskId>` | 某任务最近一次派单的事件流 |
| `/api/task/run?id=<taskId>` | 某任务最近一次派单的轻量元信息 + 回执全文 `result` + 规则摘要 `summary`（文件/动作/错误/轮次，供「标记完成」预填证据） |
| `/api/templates` | 拆分/优化用的旧提示词模板（兼容保留；新代码读 `docs/skills/*.md`） |
| `/api/skills` | `GET`：`{skills:[{name,path,content,output,fields,error}],preview}`；`POST {name,content}`：校验 frontmatter 后写 `docs/skills/<name>.md`（校验失败 400、文件不变；旧版备份到 `.history/`）。SKILL 名：`split` / `optimize`（通用）/ `optimize-dev` / `optimize-docs` / `optimize-plan` / `split-optimize` |
| `/api/skills/preview` | `{title?,note?,extra?}` → `{prompt}`：按当前 `split.md` 渲染最终 prompt |
| `/api/skills/reset` | `{name}` → 恢复内置默认（同样先备份） |
| `/api/config` | 派单环境配置（非敏感）：`defaultEnv / windowsClaudeCmd / claudeTimeoutSec / wslDistro / wslRepo / windowsClaudeEnvKeys`；只回网关变量**名**，值永远不返回 |
| `/api/wsl/ls?path=~` | 浏览 WSL 目录（选项目 / 改工作目录用） |
| `/events/losflow` | SSE：**一条**多路复用终端流，消息体带 `taskId`：`run{reset}` / `line{seq,line}` / `end`；另推 `{kind:"approval",action:"waiting"|"approved"|"rejected"|"expired",approval}`（无 `taskId`，前端收到后刷新状态） |
| `/events/claude` | SSE：tail 最新 stream-json（旧接口，保留一版兼容） |
| `/events/workbuddy` | SSE：tail `calls.jsonl` |
| `/app/` | 前端 SPA |
| `/wiki` | 驾驶舱说明页（`web/wiki.md`） |

## 写（POST）

| 路径 | body | 说明 |
| --- | --- | --- |
| `/api/pool/add` | `{title,note,kind,project,type,workType?}` | 加入池子（父条目正文可空，拆分/推入时必填）；`workType` = `dev` / `docs` / `plan`，默认 `dev` |
| `/api/pool/worktype` | `{id,workType}` | 改池子条目的工作类型（父/子都可改；子条目默认继承父条目） |
| `/api/pool/suggest` | `{id,prompt?,sync?}` | **投递型**：立刻返回 `{jobId,reused}`，后台拆分；同一池子条目在跑时再点返回同一 jobId（`reused:true`，不重复花费）。输出契约与硬规则来自 `docs/skills/split.md`（默认字段 `title/owner/reason/note`）。进度/结果走 `GET /api/job?id=<jobId>`，关弹层 / 刷新不丢。`sync:1` 保留旧行为（等结果，仅排查用） |
| `/api/pool/apply` | `{id,subs:[{title,owner?,reason?,note,workType?}]}` | 落拆分结果：子条目 `note` 必填（缺省时沿用父正文；仍为空 → 400 含标题）；`workType` 缺省继承父条目；记录父 `children`、`stage=split` |
| `/api/pool/push` | `{id,priority}` | 推入：父条目拆过时推**子任务**（不发父标题），每条任务 `note` 只放正文；正文为空 → 400；文档同步按启用且支持 `append-row` 的连接器 **fan-out**（每个连接器一条 job，各自重试）；**Claude Code 任务落库后自动派单**（WorkBuddy 任务等 WB 取走） |
| `/api/pool/note` | `{id,note}` | 编辑「任务本身」（正文）；存量空壳（如 p9）靠它补回 |
| `/api/pool/optimize` | `{id}` | 拆分前补全需求（不拆）：直连网关 → 结果写回父条目正文，返回 `{note,via}` |
| `/api/pool/remove` | `{id}` | 删池子条目 |
| `/api/task/dispatch` | `{id,task,mode,allow}` | **投递型**：立刻返回 `{started:true,taskId,env}`，后台跑；有 sessionId 则续接；服务端按 `task.repo` + `task.env` 判定环境并固化；`docOnly` / 文档操作指令直接 400；同一任务已在启动中再点 → 400（防重复花费） |
| `/api/task/continue` | `{id,task}` | 续接上次会话；同样异步返回、拒绝 `docOnly`；会话来自另一个环境（`sessionEnv` ≠ 当前 `env`）→ 400「环境已变，请新开会话」 |
| `/api/task/split` / `/api/task/optimize` | `{id,...}` | 拆分建议 / 生成 SKILL.md（取结果型；优先直连网关，不可用时退回派单链路）。`/api/task/split` 前端已无调用点，保留兼容 |
| `/api/task/note` / `/api/task/repo` / `/api/task/delete` | `{id,...}` | 改备注 / 改目录（`{id,repo,env?}`，不传 `env` 按 `auto` 重新判定）/ 删任务 |
| `/api/task/status` | `{id,status,area?,evidence?}` | 人工验收：`done` 写 `status/area/evidence/finishedAt`（工作类型沿用任务上入池时定好的值）并给腾讯文档入队一条 `update-row` 回填；`todo` 重新打开（证据保留） |
| `/api/task/worktype` | `{id,workType}` | 改任务的工作类型（`dev` / `docs` / `plan`）；taskboard 建的任务用它补，优化提示词 / 标记完成都沿用它 |
| `/api/task/nudge` | `{id}` | 生成催办文案（仅写时间戳，不通知 WB） |
| `/api/prompt/optimize` | `{text,taskId?,workType?}` | 把草稿改写成派单指令，按工作类型选 `docs/skills/optimize-{dev,docs,plan}.md`；优先直连网关，WSL 停着也能用 |
| `/api/run/stop` | `{taskId}` | 终止**这张卡自己的**派单：服务端按活进程反查 runId，再按该会话的 `env` 路由（Windows `taskkill /T /F`；WSL 杀 `/tmp` 里的 pid）；不带 taskId 时沿用旧行为（running.json 里那条） |
| `/api/run/delete` | `{id,taskId}` | 删单次会话：按 env 删 runstate / WSL 产物 + runs 归档 + 台账行 + 会话指针 |
| `/api/docsync/report` | `{id,status,evidence}` | 文档同步回调（`done`/`failed`） |
| `/api/approve` | `{id,remember?}` | `live` 请求：写 `data/live/<id>.res.json`，**同一次 run 继续执行，不重派**；`remember:true` 同时写 allowlist。`midRun` / legacy 请求：写 allowlist + 按原 `env`/`repo` 重派一次。返回带 `live:true` 或 `retry` |
| `/api/reject` | `{id}` | `live` 请求：写 deny（带「不要换个写法重试」），同一次 run 继续；legacy 只改状态 |
| `/api/maintenance/purge` | `{hours}` | 清 N 小时前的 runs、WSL `/tmp/cc-*` 与过期的 `data/runstate`；`data/jobs` 与 `data/live`（含 archive）按 7 天清理 |
| `/api/maintenance/config` / `/api/maintenance/cleanup` | `{note?,docUrl?,connector?}` | 自动整理阈值 / 整理主表按连接器 fan-out 入 docsync 队列（`action:"cleanup"`，不建任务）；没有启用连接器 → 400 |
| `/api/projects/add` / `/api/projects/remove` | `{name,path,env?}` / `{id}` | 项目列表；`env` = `auto`（默认，按路径判定）/ `wsl` / `windows` |
| `/api/config` | `{defaultEnv?,windowsClaudeCmd?,claudeTimeoutSec?}` | 写 `losflow.config.json`（只这几个字段，网关 key 不经过接口），运行中立即生效 |

## MCP（WorkBuddy 侧，stdio）

`agent/wb-bridge/server.mjs` 暴露：`list_tasks`、`next_task(owner)`、`report_task(id,status,evidence)`、`next_docsync`、`report_docsync(id,status,evidence)`、`add_task`。

- `next_docsync` 的动作：`append-row`（追加一行）/ `update-row`（回填已有行）/ `cleanup`（整理主表）。
- `add_task` 命中腾讯文档操作指令时**拒绝建任务**，提示走文档同步队列。
- `next_task` 跳过 `docOnly` 任务。
