# 驾驶舱使用说明

这份文档解释**每个按钮干什么、数据从哪来、卡住了看哪里**。改 UI 前先看这里，避免再问一次。

## 一、一条任务的生命

```
新建（加入池，选工作类型） → 拆分 → 推入 ─┬─ 任务本体：落库后自动派单（CC 干活 / WB 等取走）
                    │        └─ 文档那一行：异步队列，WorkBuddy 有空再写
                    └─ 需要 Claude Code 做的，派单给它执行
```

| 阶段 | 在哪块 | 谁在动 | 你怎么知道 |
| --- | --- | --- | --- |
| 预定 | 任务池 | 没人 | 卡片显示「未拆」 |
| 已拆 | 任务池 | 没人 | 父条目显示「已拆 N」，子条目显示「子任务」+ 继承的工作类型 |
| 已推入 | 已推入·任务 | 工作 Agent（默认 CC） | CC 任务自动派单（`执行中`）；WB 任务等待取走 |
| 执行中 | 已推入·任务 | Claude Code | `● CC 执行中 · 12s` + 实时日志 |
| 文档同步 | 已推入·任务 | WorkBuddy（异步） | `文档同步排队中 / 写入中 / 失败` |
| 回填 | 已推入·任务 | WorkBuddy | `已回填 done HH:MM` |
| 归档 | 已推入·归档 | — | 池子条目标「已推送」 |

> 重点：推入**不再等** WorkBuddy。任务进队列那一刻工作 Agent 就能开工，腾讯文档那一行由「文档同步队列」异步补写，写完自动回执。

## 二、按钮对照

### 任务池（还没派出去）

| 按钮 | 作用 | 花钱 |
| --- | --- | --- |
| 拆分 | 让 AI 拆成 3–6 条子任务，或手写一行一条；每条必须带「任务本身」（正文），工作类型默认继承父条目 | 否 |
| 推入 | 选优先级（高/中/低）后：任务本体落库，Claude Code 任务**自动派单**（提示词就是正文），WorkBuddy 任务等 WB 取走；文档那一行进异步同步队列；父条目拆过时推的是**子任务**，不会按父标题再建一条 | CC 任务会花钱 |
| 编辑正文 | 补/改「任务本身」；拆分或推入要求正文非空 | 否 |
| 删除 | 从池子移除（不影响已生成的任务；删父不会级联删子任务） | 否 |

> **工作类型**：开发 / 文档 / Plan，在新建任务或拆分时选，子条目默认继承父条目（可单独改）。它决定「优化提示词」用哪套 SKILL、任务卡上的类型角标，以及「标记完成」时的默认区域；不再在跑完之后才选。
> 子任务必须带正文（AI 没给时沿用父任务正文）；没有正文的不能勾选、不能入池、不能推入。
> 「补全需求」只补全父条目正文（补路径/验收/边界），**不拆分**，结果会写回父条目，关掉弹层也不丢。

### 已推入 · 任务

| 按钮 | 作用 | 花钱 |
| --- | --- | --- |
| 执行 | 用任务备注/提示词派一个新会话给 Claude Code | 是（约 $0.05–0.1） |
| 继续 | 续接上一次会话接着做（它记得上下文） | 是 |
| 智能拆分 | 让 Claude Code 出 3–6 条子任务建议 | 是 |
| 派单提示词 | 把任务说明改写成一条完整派单指令 | 是（约 $0.08） |
| 需求/交付/验收 | 仅公司任务；生成三段文档 | 是 |
| 换目录 | 改这条任务用哪个目录（WSL 或 Windows，环境按路径形态判定） | 否 |
| 终止 | 杀掉正在跑的 Claude Code | 否 |
| 删除 | 从任务表移除 | 否 |
| 优化提示词 | 按当前工作类型（开发 / 文档 / Plan）把输入框里的草稿改写成更好的派单指令，**改完停在框里，你决定推不推** | 是 |

### 等你授权（会话右上悬浮卡）

Claude Code 想执行但被权限拦住时，**会话右上角**会浮出授权卡（不占文档流，不参与页面/日志滚动）；当前会话的请求排最前，其他会话的请求排在后面，可点「切过去」。

- **只批这次** → 同一次 run 继续执行，不重派
- **批准并记住** → 同一次 run 继续，并把规则写进 `allowlist.json`
- **拒绝** → 这次调用带拒绝理由继续
- **终止** → 只停这张卡自己的会话
- 50s 没处理会按拒绝继续；**Windows 会弹通知 + 声音**（8s 内合并、20s 未处理再响一次）；漏批后悬停卡转灰条，留「接着跑」按钮。
- 键盘：`Ctrl+Enter` 只批这次、`Ctrl+Backspace` 拒绝（**全局生效，不用先点卡片**；焦点在输入框时不拦截）；`←/→` 切队列；卡片右上 `–` 收成小胶囊。

## 三、数据从哪来

| 页面元素 | 数据源 | 实时性 |
| --- | --- | --- |
| 任务池 / 任务 / 授权 | `data/*.json` | 实时（SSE）+ 5 秒轮询 |
| 会话日志 | `data/streams/<id>.jsonl` 或运行中的流 | 实时（`/events/losflow` 增量推，按 `seq` 合并；断线/切后台自动对账） |
| 正在跑哪条 | `data/runstate/<id>.json`（env + pid）+ 台账；WSL 看 `/tmp/cc-*.pid`，Windows 看本地 pid | 实时（每张卡认自己的会话） |
| WorkBuddy 阶段 | `tools/wb-bridge/calls.jsonl`（next_task / report_task 带 taskId） | 5 秒 |
| 今日花费 | `tools/claude-ledger.jsonl` 累加 | 5 秒 |

**关键点：所有信息都能从这几个文件推导出来，不需要进 WSL 看。**

## 三半、文档同步队列（连接器）

文档同步不再是「写死一张腾讯文档表」，而是按**连接器** fan-out；任务本体落库不受影响：

```
推入 → 任务本体落库（立即可派给工作 Agent）
     └─ docsync.enqueue()：每个启用且支持 append-row 的连接器各一条 job
          ├─ executor（tencent-wb）→ WorkBuddy 定时取 next_docsync，写完 report_docsync
          └─ direct（local-file / http-webhook）→ server 直接执行，按连接器重试
          → 面板显示已同步；失败进 failed，可「重放失败」
```

- 队列文件：`data/docsync.json`（每条 job 带 `connector` / `targetSnapshot` / `queue`）。
- 连接器配置：`data/connectors.json`；密钥：`data/secrets.json`；设置页「连接器」可改目标 / 字段映射 / 动作 / 重试，发测试行、重放失败。
- 内置：`tencent-wb`（默认启用，行为与旧版一致）、`local-file`（写 `data/ledger/<project>.md`）、`http-webhook`（POST JSON，可带 token）。
- **动作**：`append-row`（推入时写一行「开发中」）、`update-row`（标记完成时回填状态/备注）、`cleanup`（整理主表 / 台账）。维护动作同样只入队，不建任务行。
- **写文档不占任务行**：点「整理主表」或自动整理到阈值，都只往 docsync 入队；`taskboard.ps1 -Add` 与 wb-bridge `add_task` 传文档操作指令会被拒建。
- **回调 done 之后**：任务表里该条打上 `docSyncedAt`，任务卡进度条 `10% → 30%`。
- 面板接口：`GET /api/docsync`、`GET /api/connectors`；回调 `POST /api/docsync/report`；连接器设置 `POST /api/connectors`。
- MCP 工具：`next_docsync`（取一条，标 running；可传 `connector`）、`report_docsync`（done / failed）；没有启用的 executor 时这两个工具不出现在 `tools/list`。
- **WorkBuddy 侧要建一个 10–30 分钟的定时任务**：`next_docsync` → 有活就写 → `report_docsync`。没建就会一直排队，但**不影响任何任务开工**；即使 WorkBuddy 完全停摆，`local-file` 仍能留痕。

## 三·六、人验收：会话里的「标记完成」

回执 `ok` 只说明 Claude 跑完了，不说明它改对了地方。任务状态由人在「会话」页推进，不靠猜回执：

- 跑完核对后在会话详情点「**标记完成**」：工作类型入池时已定（开发 / 文档 / Plan），这里只选区域（代码区 / 文档区，文档区可逐级选路径），证据预填最后一次回执（状态 + 轮次 + 花费 + 结论摘要）。
- 确认后任务表写入 `status=done / workType / area / evidence / finishedAt`；任务进「已完成」，全部完成时阶段条到 ⑧，自动整理计数 +1。
- 同时入队一条 `update-row` 文档同步：WorkBuddy 在主表按任务名找到那一行，改「任务状态=已完成」+ 备注（类型 + 区域）；找不到就按追加一行处理。
- 标错了点「**重新打开**」：回 `todo`，证据和上次回执都保留。
- 接口：`POST /api/task/status { id, status: "done" | "todo", area?, evidence? }`；工作类型走 `POST /api/task/worktype { id, workType }`。

## 四、卡住了先看哪

| 现象 | 先看 | 处理 |
| --- | --- | --- |
| 推入了但一直显示 `文档同步排队中` | WorkBuddy 侧的定时任务建了没 | 去 WorkBuddy 建 10–30 分钟轮询 `next_docsync` |
| 任务推入后一直 `待派单` | 是不是 WorkBuddy 任务，或命中了文档同步指令 | Claude Code 任务推入即自动派单；WB 任务等 WB 取走 |
| 会话跑完了但任务还是 `待派单` | 这是设计如此（回执 ≠ 完成） | 去「会话」页点「标记完成」，选区域 |
| 卡片一直「执行中」但日志不动 | `running.json` 是不是残留 | 点「终止」 |
| 派单报错 / 结果为空 | 台账最后一条的 status 和 denials | 看 `claude-ledger.jsonl` |
| 授权队列里有东西 | 命令原文是否合理 | 右上悬浮卡批准 / 拒绝；拒绝不会重派 |
| 授权没有弹 Windows 通知 | 设置页「Windows 提醒」状态；服务是否跑在登录会话 | `notify.enabled=false` 或 session 0 时不会弹 |
| 授权超时后会话停住 | 会话头部是否出现「接着跑」 | 点它续接上一次会话，不用回任务页 |
| 花费飙升 | 今日花费数字 | 派单脚本默认日上限 $5 |

## 五、命令行等价物

不想点页面时：

```powershell
# 看任务表 / 池子
.\taskboard.ps1 -List

# 派活
.\claude-dispatch.ps1 -Task '<四件套>' -Allow 'Bash(npm run typecheck:*)'

# 花费
.\claude-ledger.ps1 -Query summary

# 起驾驶舱
node .\dashboard\server.mjs     # http://127.0.0.1:8899/app/
```
