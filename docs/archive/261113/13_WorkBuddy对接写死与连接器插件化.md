# 13 · WorkBuddy 对接写死在一张腾讯文档表上，能力只覆盖三个动作

| 项 | 内容 |
| --- | --- |
| 编号 | 13 |
| 日期 | 2026-11-13 |
| 项目 | LosFlow（`D:\PROJECT\LosFlow`） |
| 类型 | 配置模型 + 连接器插件化（后端为主，前端设置页 + 少量派单分流） |
| 状态 | 方案待确认（未实施） |
| 提出 | 杰哥（2026-11-13：「当前的 WorkBuddy 是写死的哪个文档对么？然后我们默认也只能对接很小一部分功能；增加自定义设置以及多种对接方式，类似 DSH 那种插件模式」） |
| 涉及文件 | `server/docsync.mjs`、`server/connectors/*`（新增）、`server/connector-host.mjs`（新增）、`server/server.mjs`、`server/paths.mjs`、`agent/wb-bridge/server.mjs`、`agent/sync-mcp.ps1`、`agent/taskboard.ps1`、`web/src/views/SettingsView.vue`、`web/src/store/useSettings.ts`、`web/src/store/useTasks.ts`、`losflow.config.example.json`、`docs/api.md`、`docs/architecture.md`、`README.md`、`agent/wb-bridge/README.md`、`scripts/smoke.mjs` |

## 一句话结论

**不是"WorkBuddy 写死"，是整条文档同步链路写死**：一个厂商（腾讯文档）、一个 URL（`…/sheet/DZVFSeURwdmVJdVZL?tab=BB08J2`，在 4 个地方各抄了一遍）、一张表的 4 列（`subject/priority/status/note`）、3 个动作（`append-row` / `update-row` / `cleanup`）、2 个 owner（`claude-code` / `workbuddy`）、1 个传输（stdio MCP + `~/.workbuddy/mcp.json`）。所以能对接的只有「追加一行 / 改两列 / 把已完成行移到归档 tab」这一小块，其余（读回、多文档、按项目分表、其他平台、失败重放）全部没有。现场数据也印证：`data/docsync.json` 5 条**全是 pending**、`docSyncedAt` 0 条、最近一次 WorkBuddy 调用停在 17:17——人一停，队列就永久堆着，且没有告警。

改法：① 先把「目标 / 字段映射 / 匹配规则」抽成**配置**（设置页可改，代码里不再出现具体 URL/列名）；② 再抽一层**连接器 SPI**（`connector.json` + `apply(host)`，执行型 / 直连型两种），内置腾讯文档（行为不变）+ 本地台账 + HTTP webhook 三个；③ MCP 工具按启用的连接器动态生成，队列项带 `connector`，各自重试、可重放。范式对齐 DSH 的插件模型（manifest 声明 + 运行时 `apply` + 管理面启用/禁用/健康）。

---

## 1. 现状：写死清单（逐项带行号）

| # | 写死的东西 | 位置 | 现在只有 | 要多后端得动什么 |
| --- | --- | --- | --- | --- |
| 1 | 目标文档 URL | `server/docsync.mjs:17-18`（`DEFAULT_DOC`）、`server/server.mjs:294`、`server/server.mjs:953`、`web/src/store/useSettings.ts:61` | 同一个 sheet 地址抄了 4 遍；`/api/maintenance/cleanup` 虽然收 `docUrl`，但前端 `useTasks.ts:291` 永远发 `{}`，等于死参数 | 收进 `connectors[].target`，一处定义 |
| 2 | 判定「这是文档活」 | `server/docsync.mjs:50-52`（`docs.qq.com` + 中文动作词）、`agent/taskboard.ps1:86`（同一套正则又抄一遍） | 只认腾讯文档 + 4 个中文词 | 改成 connector 的 `match: {urlPatterns, keywords}` |
| 3 | 动作词表 | `docsync.mjs:89-107`（append-row）、`:112-148`（update-row）、`:152-177`（cleanup） | 固定 3 个 | 动作由 connector 的 `capabilities` 声明 |
| 4 | 字段 / 列 | `docsync.mjs:97`、`:116-121` 的 `payload {subject,priority,status,note}` | 固定 4 字段 | 进 `connectors[].mapping`（列名映射） |
| 5 | 表格结构 / tab | `server.mjs:293-305`（`cleanupNote()`）、`:954-963`（路由里又抄一份） | 「主表 tab BB08J2」「归档 tab」「序号列沿用公式」写成中文散文 | 由 connector 的 `describe(action,payload)` 生成 |
| 6 | 任务表文件 | `agent/wb-bridge/server.mjs:28-29`（默认 `data/Vesta.tasks.json`，可用 `WB_TASKS_FILE` 覆盖）、`docsync.mjs:220`（回写同一文件名） | 一个文件；README 里还是旧路径 `D:\PROJECT\Ds\tools\wb-bridge`、`D:\SOFT\nodejs\node.exe` | 走 `PATHS`，README 同步修 |
| 7 | 传输 / 注册 | `agent/wb-bridge/server.mjs`（stdio JSON-RPC）、`agent/sync-mcp.ps1` 生成 `~/.workbuddy/mcp.json` | 一个 server 名 `ds-taskboard`；必须在 WorkBuddy 里手点「信任」；工具固定 6 个（README 说 4 个，已过期） | 工具表按启用连接器动态生成；`mcp.json` 带环境变量区分 |
| 8 | 执行体枚举 | `docs/skills/split.md:16`、`server/skills.mjs:52`、`web/src/utils/split.ts:52`、`web/src/dialogs/SplitDialog.vue:59` | 只有 `claude-code` / `workbuddy` | 变成「连接器 id」，或在任务上存 `owner + connectorId` |
| 9 | 状态面 | `server/events.mjs:714+`（tail `calls.jsonl`）、`web/src/store/useWb.ts:42`、`web/src/views/WbView.vue` | 只看得到「WorkBuddy 调了什么」，看不到「队列卡在哪 / 为什么」 | 连接器健康 + 队列统计进 `/api/state` |
| 10 | 配置面 | `losflow.config.example.json` | 只有 wslDistro / windowsClaude* / liveApprove 等，**没有任何文档或连接器字段** | 新增 `connectors[]` |

## 2. 能力天花板：「只能对接很小一部分」具体是哪些

| 现在能做 | 常见需求但做不到 |
| --- | --- |
| 追加一行（4 个字段） | 读回表格内容、按条件查行、建表 / 建 tab、写第二个文档、按项目分表、附件、评论、权限 |
| 改两列（任务状态 + 备注） | 改任意列、改格式、合并单元格、维护公式 |
| 整表整理（已完成 / 已搁置 → 归档 tab） | 增量对账、差异同步、失败补偿、回滚 |
| 结果只有「WorkBuddy 自己说 done」 | 没有结果 schema 校验、没有读回证据结构；失败只有一段 `lastError` 字符串 |
| 重试固定 3 次、无退避、15 分钟算卡死（`docsync.mjs:20-21`） | 死信队列、人工重放、按连接器不同策略 |
| 单队列单文件（`data/docsync.json`） | 优先级、并发度、按连接器分流、跨连接器幂等 |

## 3. 现场数据：链路跑通过一次，之后靠人肉维持

| 证据 | 值 |
| --- | --- |
| `data/docsync.json` | 5 条，**全部 pending**（3 条 append-row / 2 条 update-row），`docUrl` 只有那一个 |
| `data/calls.jsonl` | 25 次调用：`initialize` 14、`next_task` 5、`list_tasks` 2、`report_task` 2、`next_docsync` **1**、`report_docsync` **1** |
| 最后一次 WorkBuddy 调用 | 2026-11-13 17:17（之后 3 小时无调用，队列继续涨） |
| `data/Vesta.tasks.json` | 6 条任务，`docSyncedAt` **0 条**，`docOnly` 1 条 |
| `docsync.summary()` | 已在 `/api/state` 里，但没有任何界面/告警消费 pending 数与「超过 N 小时没人取」 |

**结论**：这条链路不是"坏了"，是"必须一直有人记得去 WorkBuddy 建定时任务 + 保持信任"。一旦断了，积压只是数字，没人会看见。

---

## 4. 目标 / 非目标

**目标**

1. **可配置**：目标地址、tab、列名映射、动作集合、匹配规则、重试策略 → 配置文件 + 设置页；代码里不再出现具体 URL / 列名 / tab id。
2. **可插拔**：一套最小连接器 SPI（`connector.json` + `apply(host)`），内置 3 个（腾讯文档-经 WorkBuddy / 本地台账 / HTTP webhook），第三方按目录加。
3. **多连接器并行**：一个动作可以同步到多个目标（公司表 + 本地台账），各自队列、各自重试，互不阻塞。
4. **可观测**：连接器健康（最近成功/失败/积压数）进设置页，支持「发测试行」「重放失败」。
5. **不破坏现状**：默认仍是「WorkBuddy 取 docsync 队列」；未配置时用内置默认（等价今天的 URL 与散文），老数据自动补 `connector` 字段。

**非目标**

- 不做腾讯文档官方 API 直连（需要企业资质/授权；作为「直连型连接器」的二期项）。
- 不改 DSH 侧（这是 LosFlow 自己的连接器层；DSH 只提供范式参考）。
- 不做双向冲突合并（一个目标只有一个写入方，按 target 串行）。

---

## 5. 方案 A：配置模型（先让"能改"，不必先"能插"）

`losflow.config.json` 增 `connectors`（不含密钥；密钥单独放 `data/secrets.json`，git 忽略）：

```json
{
  "connectors": [
    {
      "id": "tencent-wb",
      "kind": "workbuddy-tencent-doc",
      "enabled": true,
      "label": "腾讯文档任务表（WorkBuddy 执行）",
      "target": { "url": "https://docs.qq.com/sheet/DZVFSeURwdmVJdVZL?tab=BB08J2", "tab": "BB08J2", "archiveTab": "归档" },
      "mapping": { "title": "任务", "status": "任务状态", "note": "备注", "priority": "优先级", "serialFormula": true },
      "actions": ["append-row", "update-row", "cleanup"],
      "match": { "urlPatterns": ["docs\\.qq\\.com"], "keywords": ["append-row", "update-row", "腾讯文档任务表", "整理.*主表"] },
      "queue": { "maxAttempts": 3, "staleMs": 900000 }
    }
  ]
}
```

落点两条路，二选一（待定，见风险 R2）：

- **A1（省事）**：直接进 `losflow.config.json`，与派单配置同源，`/api/config` 白名单返回；
- **A2（干净）**：独立 `data/connectors.json`（可热改、不进 git、备份随 `data/`），`losflow.config.json` 只留一个 `connectorsFile` 指针。

倾向 A2：连接器配置里迟早会带密钥/内网地址，不宜和机器配置混。

代码侧改动要点：

- 删 `DEFAULT_DOC`；`enqueue*` 从 connector 取 `target/mapping/queue`，队列项**快照**目标（见 R2）。
- `isDocSyncInstruction(text)` → `connector.match(text)`；`docsync.mjs` 不再 import 任何腾讯文档常量。
- `cleanupNote()` → `connector.describe("cleanup", payload)`，散文模板放连接器里（可编辑）。
- `agent/taskboard.ps1:86` 的重复正则 → 调 `node server/cli/docsync-check.mjs`（或直接用连接器的 match 结果，脚本只做"拒绝建文档任务"的兜底）。

---

## 6. 方案 B：连接器 SPI（对齐 DSH 插件模型）

### 6.1 先看 DSH 是怎么做的（可对照的部分）

| DSH | 位置 | 作用 |
| --- | --- | --- |
| `package.json` 的 `dsh` 字段 | `@deepseek-ai/dsh-package-manifest/src/types.ts` | `manifestVersion` / `bundle{patch, platforms, listedByDefault}` / `profile{bundles[]}` / `client{platform, inject, immediately, external}` / `engines{ dsh, node }` |
| 显示元数据 | 同上 `PluginLocalizedMeta` | 图标（≤256KiB）、标题、描述、本地化文案；缺了也能管 |
| 运行时 | `apply(ctx)` + `ctx.inject` + `ctx.effect`（Cordis）；DSH 侧栏插件见 `packages/dsh-plugin/client.js` | 插件拿到 `slots/locale/sidebarRightTabs` 三类服务后注册自己的能力 |
| 管理面 | `plugin_manager` 工具 / 设置页「插件」 | 列表、启用/禁用、安装 bundle、版本要求校验、构建脚本需人工批准 |
| 版本与安全 | `engines.dsh` 不满足则拒绝激活 | 声明式约束，不当运行时依赖去赌 |

**可以照搬的**：manifest 声明 + 单一入口 `apply(host)` + 能力声明 + 管理面开关 + 健康/版本检查。
**不该照搬的**：npm 安装 + 构建脚本自动执行（LosFlow 是本地单机工具，安装即执行代码的风险收益不划算，本期只做「目录扫描 + 启用开关」）。

### 6.2 连接器包约定

```
connectors/<id>/
  connector.json     # manifest
  index.mjs          # export default { apply(host) }
  README.md          # 怎么配、需要什么人做（例如 WorkBuddy 里建定时任务）
```

`connector.json`：

```json
{
  "manifestVersion": 1,
  "id": "tencent-wb",
  "kind": "executor",
  "version": "1.0.0",
  "label": { "zh": "腾讯文档任务表（WorkBuddy 执行）", "en": "Tencent Docs board (WorkBuddy)" },
  "icon": "icon.svg",
  "engines": { "losflow": ">=0.1.0" },
  "capabilities": ["doc.appendRow", "doc.updateRow", "doc.cleanup", "tasks.next"],
  "configSchema": { "type": "object", "properties": { "target.url": { "type": "string" } } },
  "secrets": ["token"],
  "match": { "urlPatterns": ["docs\\.qq\\.com"], "keywords": ["append-row", "update-row"] }
}
```

### 6.3 主机能力（`host`）

```js
const host = {
  queue: { enqueue(action, payload, opts), next({ connector }), report(id, status, evidence), stats(connector) },
  tasks: { list(), find(id), markSynced(id) },
  config: { get(connectorId), schema(), secret(name) },   // secret 只回值给连接器，不进 /api/config
  mcp:   { registerTool(schema, handler) },               // 执行型连接器可以加自己的取活工具
  log:   { info, warn, error },                           // 写 data/connectors/<id>.log（按天切）
  http:  { fetch },                                        // 直连型用
};
export default { apply(host) { /* 注册 describe / write / health */ } };
```

**两种形态**：

| 形态 | 谁执行 | 连接器要提供 | 例子 |
| --- | --- | --- | --- |
| `executor`（外部 agent 执行） | WorkBuddy / 其他 Web Agent，通过 MCP 取活 | `match(text)`、`describe(action, payload)` → 人话指令、`mcp.registerTool` | tencent-wb |
| `direct`（本进程直连） | LosFlow server | `write(action, payload)`、`read(query)`、`health()` | local-file、http-webhook |

### 6.4 MCP 面（多连接器并存，但别把工具列表撑爆）

- `next_docsync` 增可选 `connector` 过滤；返回文本里第一行带 `connector: tencent-wb`；
- `tools/list` 按**启用状态**生成：执行的连接器才有 `next_*`/`report_*`；`list_tasks` / `report_task` / `add_task` 保持全局；
- 每个 `executor` 连接器默认复用同一组 `next_docsync` / `report_docsync`（工具名稳定，WorkBuddy 侧不用改配置），靠参数区分。

### 6.5 管理面（设置页「连接器」）

```
连接器                                   [+ 添加连接器]
──────────────────────────────────────────────────────
● 腾讯文档任务表（WorkBuddy 执行）   启用 ●   最近成功 17:17 · 积压 5
   目标 …/sheet/DZVF…tab=BB08J2     [测试行] [重放失败] [编辑]
○ 本地台账（data/ledger/…）          启用 ○   最近成功 —      · 积压 0
```

- 表单由 `configSchema` 生成（不写死每个连接器的 UI）；
- 密钥字段只显示「已配置 / 未配置」，永不回显；
- 「测试行」= 入队一条 `action:"probe"` 的项，直连型立刻写、执行型交给 WorkBuddy 并等回执；
- 「重放失败」= 把 `failed` 的队列项改回 `pending`（保留 attempts 记录）。

### 6.6 内置三个（先够用）

| id | 形态 | 能力 | 为什么要有 |
| --- | --- | --- | --- |
| `tencent-wb` | executor | append-row / update-row / cleanup | 现状，行为不变（默认启用） |
| `local-file` | direct | `data/ledger/<project>.md` 追加行、按任务名改状态 | 不依赖 WorkBuddy 也能留痕；断网/没信任时的兜底 |
| `http-webhook` | direct | POST/PATCH 一个 JSON 到自建端点 | 接 n8n / 飞书机器人 / 自建服务，最通用的"别人怎么写我不管" |

二期：`feishu-sheet`、`notion`、`tencent-doc-api`（官方 API，需资质）。

---

## 7. 改动清单

| 文件 | 改什么 | 估算 |
| --- | --- | --- |
| `server/connector-host.mjs` | **新增**：注册表、manifest 校验、API 版本、`host` 注入、健康状态 | 180 行 |
| `server/connectors/tencent-wb/*` | **新增**：现有散文模板 + match + describe（行为不变） | 120 行 |
| `server/connectors/local-file/*` | **新增**：Markdown 表格追加 / 改行 / 读回 | 150 行 |
| `server/connectors/http-webhook/*` | **新增**：POST/PATCH + 超时 + 失败分类 | 90 行 |
| `server/docsync.mjs` | 去 `DEFAULT_DOC` 与硬编码 payload；动作/字段/重试从 connector 取；队列项带 `connector` + `targetSnapshot`；`nextJob(connector?)`、`replay(id)` | +80 / −40 行 |
| `server/server.mjs` | `/api/connectors`（GET 列表+健康 / POST 增删改 / POST test / POST replay）；`cleanupNote` → connector.describe；`/api/state` 加 `connectors` 摘要 | +120 行 |
| `server/paths.mjs` | `connectorsDir`、`secretsFile`、`ledgerDir` | +10 行 |
| `agent/wb-bridge/server.mjs` | 工具表按启用连接器生成；`next_docsync`/`report_docsync` 带 connector；删掉中文散文（改由 describe 给） | +40 / −30 行 |
| `agent/sync-mcp.ps1` | `mcp.json` 写入 `WB_CONNECTORS` / `LOSFLOW_DATA` 环境变量；提示语按连接器生成 | +15 行 |
| `agent/taskboard.ps1` | 删重复正则，改调 `server/cli/docsync-check.mjs` | −8 行 |
| `web/src/views/SettingsView.vue` | 「连接器」面板（列表 + 动态表单 + 测试行 + 重放） | +160 行 |
| `web/src/store/useSettings.ts` | 连接器 CRUD / test / replay；删 `buildCronPrompt` 里的写死 URL（改按连接器生成） | +60 / −10 行 |
| `web/src/store/useTasks.ts`、`web/src/components/TaskCard.vue` | 推入/标记完成时按任务上的 `connectorId` 分流；无连接器时提示 | +20 行 |
| `losflow.config.example.json` / `docs/api.md` / `docs/architecture.md` / `README.md` / `agent/wb-bridge/README.md` | 新配置、接口、架构图；修掉旧路径与「4 个工具」 | — |
| `scripts/smoke.mjs` | 连接器注册、单连接器队列、match 判定、重放 | +40 行 |

## 8. 迁移与兼容

| 情况 | 处理 |
| --- | --- |
| 存量 `docsync.json`（5 条 pending，无 `connector`） | 启动时补 `connector:"tencent-wb"`、`targetSnapshot` 用当前配置；写回前先备份 `docsync.json.bak` |
| 旧数据里的未知 `action` | 不静默丢：标 `failed` + `lastError:"未知动作，迁移后需人工处理"`，设置页可重放 |
| 没配任何连接器 | 用内置默认（等价今天的行为），不报错；`/api/state.connectors=[]` 时设置页给「用默认」提示 |
| `isDocSyncInstruction` 旧调用点 | 保留导出，内部转调 `tencent-wb.match()` |
| `WB_TASKS_FILE` | 保留，优先级高于连接器默认 |

## 9. 验收标准

1. 设置页「连接器」能看到列表与健康状态；关掉 `tencent-wb` 后推入既不入队也不报错，界面明确提示「没有启用文档连接器」。
2. 把 `target.url` 改成另一个 sheet → 新入队条目用新地址，**不改代码、不重启**（A2 热改）或重启后生效（A1，二选一写明）。
3. `local-file`：推入一条任务 → `data/ledger/<project>.md` 出现一行；标记完成 → 该行状态改为「已完成」，不需要 WorkBuddy。
4. 一个动作配两个连接器 → 队列两条、各自重试、一个失败不影响另一个。
5. `http-webhook` 打到本地 mock：收到正确 JSON；连续失败 3 次进 `failed`；设置页「重放」后回到 `pending` 并再次尝试。
6. MCP `tools/list` 只列启用连接器的工具；`next_docsync` 返回带 `connector`；未启用任何 executor 时 `next_docsync` 返回「暂无」而不是报错。
7. 未配置连接器时与今天完全一致：`npm run smoke` 绿、推入后 `docsync.json` 出现同名条目、`tests` 全绿。
8. 密钥不出现在 `/api/config`、`/api/state`、日志；`data/secrets.json` 在 `.gitignore` 里。
9. 积压告警（二期可选）：pending 超过 N 小时未被取 → 走 12 号的 Windows 提醒。

## 10. 风险与待确认

| # | 风险 / 待定 | 说明与倾向 |
| --- | --- | --- |
| R1 | 腾讯文档那段「人话指令」搬进连接器后，WorkBuddy 的理解可能变差 | 那段散文是它唯一的行为指南，必须保留且**可编辑**（`connectors/tencent-wb/prompts/*.md`），默认值与今天一字不差 |
| R2 | 配置一多，谁在写哪张表说不清 | 队列项存 `targetSnapshot`（URL/tab/列映射的副本）；改配置只影响新 job，在飞的按快照执行 |
| R3 | 密钥落盘 | `data/secrets.json`（git 忽略，随 `data/` 备份）；接口只回 `hasToken`；日志脱敏 |
| R4 | 连接器 = 本机代码执行 | 只在启用时 import；路径限定 `connectors/`（realpath 校验）；manifest 必填字段校验；不做 npm 安装 |
| R5 | 多连接器写同一目标 | 按 target 串行（同一 target 只允许一个 pending job，其余排队）；冲突在入队时拦住 |
| R6 | A1 还是 A2 落点 | 倾向 A2（独立 `data/connectors.json`，可热改、带密钥不混 config）；需杰哥定 |
| R7 | WorkBuddy 侧仍要人建定时任务 | 本期不改它的调度；二期用「积压告警 + 设置页一键复制提醒文案」缓解 |
| R8 | 是否要保留 `docOnly` 概念 | 需要：文档活不占任务行。改成「由连接器声明的动作」而不是字符串匹配，但字段保留（历史数据在用） |
| R9 | 二期官方 API 直连 | 需要腾讯文档开放平台权限；先看 `http-webhook` 能不能覆盖需求，再决定 |

## 11. 实施顺序与预估

| 步 | 内容 | 预估 |
| --- | --- | --- |
| 1 | `connector-host` + 注册表 + 把现有逻辑包成 `tencent-wb`（**行为不变**，先跑通一次 docsync） | 1 天 |
| 2 | 配置模型（A2）+ 设置页面板（列表 / 动态表单 / 测试行 / 重放） | 1 天 |
| 3 | `local-file` + `http-webhook` 两个直连型连接器 | 1 天 |
| 4 | MCP 工具动态化、队列迁移、`smoke` 与文档 | 0.5 天 |

**合计约 3.5 天**。第 1 步单独就能让"改地址 / 改列名"不必改代码；第 3 步之后即使 WorkBuddy 完全停摆，本地台账仍然有记录。

---

## 变更记录

- 2026-11-13 初稿：现状核对（10 类写死项 + 行号，含同一个 URL 抄 4 处、`docUrl` 死参数、`taskboard.ps1` 重复正则、README 旧路径与「4 个工具」过期）、能力天花板对照、现场数据（5 条 pending / `docSyncedAt` 0 / 最后一次调用 17:17）、配置模型 A1/A2、连接器 SPI（executor / direct 两形态 + `host` 能力 + 动态 MCP 工具 + 管理面）、三个内置连接器、迁移与验收 9 条、风险 9 条、排期 3.5 天。
