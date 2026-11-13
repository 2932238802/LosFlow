# REVIEW · 261113 问题清单开发完成度核对

| 项 | 内容 |
| --- | --- |
| 日期 | 2026-11-13 |
| 项目 | LosFlow（`D:\PROJECT\LosFlow`） |
| 方式 | 只读代码核对 + 运行测试（未改任何源码；本文件除外） |
| 结论 | **10 项都有实现，8 项文档已闭合；7、10 代码已落地但文档状态/验收未闭合；README 索引 4/5/6 状态过期** |

---

## 一、结论先说

**代码层面：10 个问题全部有对应实现，没有发现只写方案没动代码的条目。**

**文档层面：没有全部闭合。** 具体是三类问题：

1. **README 索引与正文不一致（3 条）**：4、5、6 在各自文件头已写「已处理 / 已实施」，README 清单仍写「待处理 / 未实施」。
2. **正文状态与代码不一致（2 条）**：7、10 文件头和 README 都写「未实施」，但代码已经落地（`server/env.mjs`、`agent/runners/`、`docs/skills/`、`pool.applySplit` 等），且这两份文件没有实施变更记录、没有验收记录。
3. **交付层面未收口**：本轮 55 个变更/新增条目全部在工作区，尚未提交（`git log` 仍停在 `4b9d9b9 [feat] version 1.0`）。「开发完毕」成立，「交付完毕」不成立。

另外有两处「验收口径」上的历史偏差，不属于功能缺失：

- 3 号要求「新增每个文件 ≤ 250 行」，当前 `useTerminal.ts`（370）、`usePool.ts`（326）、`useTasks.ts`（314）超线——这是 5/6/7/8/10 号后续加功能长出来的，`App.vue` 已从 918 行降到 64 行，拆分本身完成。
- 10 号要求「p9/p10 编辑正文」，p9 目前仍是空正文；但文档「不做的事」明确写了「不自动重写 p9/p10 的正文」，属于按设计保留，需人工补。

---

## 二、逐条核对

| 编号 | 文档自称 | 代码核对 | 静态验收证据 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | 已修复 | 有 | `POST /api/task/status` 支持 `done/todo` + `workType/area/evidence`；`MarkDialog`、`DoneView`、`docsync.enqueueBackfill` | ✅ 已实现 |
| 2 | 已实施 | 有 | `AppSidebar.vue` 一级 4 项 +「已完成」钉在栏底（同日修订口径） | ✅ 已实现 |
| 3 | 已完成 | 有 | `App.vue` 64 行；`views/ components/ dialogs/ store/ utils/` 齐备；`dist` 19:42 晚于源码最后修改 | ✅ 已实现 |
| 4 | 已处理 | 有 | `docOnly` 全链路过滤；`docsync.enqueueMaintenance`；`taskboard.ps1 -Add`、wb-bridge `add_task` 拒建；`assertDispatchable`；smoke 覆盖 | ✅ 已实现 |
| 5 | 已实施 | 有 | `store.mutate` 串行写；派单投递化 + `starting`；`/api/state` 缓存 + 20s 扫描；`/events/losflow` 单条 SSE；`/api/run/stop` 按 taskId；`KeepAlive`；ESC/草稿/确认框 | ✅ 已实现 |
| 6 | 已实施 | 有 | `readRunRounds` + `?v=2`；`utils/terminal.ts` 渲染/摘要/异常；两栏 `TerminalsView` + `SessionList`；搜索/过滤/键盘；单测 16 条 | ✅ 已实现 |
| 7 | 未实施 | **有** | `server/env.mjs` 统一判定；`agent/runners/run-wsl.ps1` / `run-windows.ps1`；`-Env`；`data/runstate` 替代全局 running；Windows 扫描合并；设置页可编辑；README/docs 已改 | ⚠️ 代码完成，文档未闭合 |
| 8 | 已实施 | 有 | `server/jobs.mjs`（幂等/reap/prune）；`/api/pool/suggest` 返回 jobId；`/api/job(s)`；`useJobs`；`SplitDialog` 内嵌进度；`PoolPanel` 行内徽标；`sync:1` 兼容 | ✅ 已实现 |
| 9 | 已实施 | 有 | `agent/approval-mcp.py`；runners 注入 `--permission-prompt-tool`；`approvals.mjs` live 队列/超时/归档；`AuthRail` 实时卡片；降级 C `recordMidRunDenial` | ✅ 已实现 |
| 10 | 未实施 | **有** | `applySplit` 强制 `note`（缺则抛错，400）；确认继承父条目且子条目只读；`setNote` + 面板编辑；`docs/skills/{split,optimize,split-optimize}.md` + 校验/备份/预览；容错解析 + 第 N 条提示 | ⚠️ 代码完成，文档未闭合 |

---

## 三、7 号与 10 号的「未闭合」具体指什么

### 7 号 · 派单按项目环境分流

代码已落地（文件时间 19:29–19:30，晚于文档 19:09）：

- `server/env.mjs`：`resolveEnv(path, explicit, defaultEnv)`，与 `agent/_paths.ps1` 同规则。
- `agent/runners/run-wsl.ps1` / `run-windows.ps1` + `_common.ps1`；`claude-dispatch.ps1` 增 `-Env`。
- `dispatch.mjs` 的归档 / 终止 / 扫描按 env 分支；去重 hash 含 env。
- 项目/任务 `env` 字段、设置页 `defaultEnv`/`windowsClaudeCmd`、README 与 `docs/api.md` 的环境说明均已更新。

**缺的是文档收口**：

- 文件头状态仍写「方案待确认（未实施）」。
- 「变更记录」只有 19:09 的初稿，没有实施记录。
- 10 条验收里第 2、3、4、5、8 条依赖真实环境（`wsl --shutdown` 后派 Windows、WSL/Windows 并发、跨环境 session、路径错配 rc=90、流回放），仓库里没有实测记录。
- 「待确认」7 条（网关 key 复用、Windows MCP、UNC、硬校验/自动纠正、stdin 实测等）未在文档里标记结论。

### 10 号 · 拆分子任务正文与三项确认

代码已落地：

- `pool.applySplit` 的 `note` 为必填（子任务为空时抛 `子任务缺少任务本身（note）：<标题>`，HTTP 400）。
- 三项确认只允许在父条目勾选（`toggleConfirm` 对子条目抛错），拆分子条目复制父结果、前端只读展示「确认继承自 …」。
- `docs/skills/split.md` 的 frontmatter `fields` 决定输出契约；`skills.mjs` 校验字段白名单、保存前校验、旧版备份到 `.history/`、支持预览/恢复默认；每次请求现读，改文件不重启生效。
- `POST /api/pool/note` + `PoolPanel`「编辑正文」；拆分结果容错解析并在前端提示「第 N 条不合法」，空正文不能勾选。
- 推入侧 `autoStarted` 生效；拆分默认走 `metaOrDispatch`（网关直连，失败回落 CC）。

**缺的同样是文档收口**：

- 文件头状态仍写「方案待确认（未实施）」，变更记录只有「19:2x 建档」。
- 「八、待确认」4 个问题（确认只留三条还是只留授权、删父是否保留子、SKILL 位置、p9/p10 如何处理）在代码里已经按推荐案落地，但文档没有回填结论。
- 未记录 `npm run verify` / smoke 对本项验收的实测结果（本次复核已另外跑过，见下）。
- `p9` 正文仍为空（存量数据；按文档「不做的事」不自动编造，需人工补或重拆）。

---

## 四、本次实际运行的验证

在只读前提下运行了以下命令（未改代码、未重新构建）：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 16/16 通过（`split.test.ts` 7 + `terminal.test.ts` 9） |
| `npm run typecheck` | 通过（`vue-tsc --noEmit` 无输出） |
| `npm run smoke` | 27 项全部通过，包含 `/api/state`、`/api/jobs`、`/api/job` 404、SKILL 校验、空子任务 400、docOnly 拒绝派单、`/api/task/raw?v=2`、SSE、`/app/`、`/wiki` |

未重跑 `npm run build`：`web/dist` 产物时间 19:42，晚于源码最后修改，且 smoke 的 `GET /app/` 返回 200。若要作为交付闸门，建议提交前再跑一次 `npm run verify`。

未做的验证（需要真实运行环境/人工）：

- 7 号：停掉 WSL 后派 Windows 任务、WSL/Windows 并发、终止互不影响、跨环境 session 拒绝。
- 9 号：真实 run 中 3 秒内出现审批卡、批准后同一次 run 继续、超时自动拒绝（文档称最小验证已通过，但仓库无原始日志）。
- 5 号：浏览器逐页手点与「切走 30 秒回来」体验回归。
- 10 号：用真实父任务重拆一次，确认 note 含原文路径/编号，推入后台账 `task_preview` 是需求原文。

---

## 五、建议的收尾动作（本次未执行）

1. 更新 `docs/archive/261113/README.md` 的 4/5/6 状态，改为与正文一致（已处理/已实施）。
2. 给 7、10 两份文件补「实施」变更记录、把文件头状态改为「已实施（待真实环境验收）」，并回填各自「待确认」的结论。
3. 在 7 号补一条真实 Windows 派单验收记录（或明确标注「未实测」）。
4. 人工处理 `p9` 正文（编辑补回或删除重拆）。
5. 提交：当前 55 个变更/新增条目仍未入库；提交前跑 `npm run verify`。

---

## 六、核对边界

- 本报告只做静态代码 + 现有测试核对，不替代真实派单/浏览器人工验收。
- 行号未写入本报告，避免 7/8/9/10 号并行改动后漂移；定位一律用文件 + 函数/路由名。
- 核对期间未修改任何源码、配置或数据；只新增了本文件。
