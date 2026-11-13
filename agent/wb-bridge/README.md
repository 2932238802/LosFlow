# wb-bridge · 让 WorkBuddy 来取活

一个本地 MCP server（stdio，零依赖）。WorkBuddy 通过「自定义连接器」接上它，就能：

```
LosFlow 写任务（taskboard.ps1 / pool 推入）
        ↓  同一份 data/Vesta.tasks.json
wb-bridge 的 6 个工具  ←  WorkBuddy 的定时任务每 N 分钟调一次
        ↓
WorkBuddy 干活（本机执行），把结果回填 / 汇报文档同步
        ↓
LosFlow 用 taskboard.ps1 -List 或面板看到结果
```

方向是 **WorkBuddy 主动来取**，所以不需要开放平台、不需要企业资质、不需要 API key。

## 工具

| 工具 | 作用 |
| --- | --- |
| `list_tasks` | 列出全部任务（只读） |
| `next_task` | 取第一个 `todo` 并标记 `doing` |
| `report_task` | 按 id 回填 `done` / `blocked` + 证据 |
| `add_task` | 新增任务（文档操作指令会被拒绝） |
| `next_docsync` | 取一条 executor 连接器的文档同步（可传 `connector` 过滤；返回第一行带 `connector: <id>`） |
| `report_docsync` | 回执文档同步 `done` / `failed` |

`next_docsync` / `report_docsync` 只在至少一个 executor 连接器启用时出现在 `tools/list` 里；工具名稳定，不需要为每个连接器改配置。没有启用时返回「暂无文档同步任务」而不是报错。

## 数据

- 任务表：`data/Vesta.tasks.json`（可用 `WB_TASKS_FILE` 覆盖）
- 文档同步队列：`data/docsync.json`（与 server 同一份；每个 job 带 `connector`）
- 连接器配置：`data/connectors.json`；密钥：`data/secrets.json`
- 默认文档连接器：`server/connectors/tencent-wb/`（WorkBuddy 执行）

## 接入步骤

1. 在仓库根执行 `agent/sync-mcp.ps1` 重新生成 `~/.workbuddy/mcp.json`（路径按当前仓库解析，并带 `LOSFLOW_DATA` / `LOSFLOW_CONNECTORS_FILE` 环境变量）。

2. 打开 WorkBuddy → 连接器管理 → 右上角「自定义连接器」→ 给 `ds-taskboard` 点一次「信任」。
   不点不生效，这一步只能人做。

3. 验证：在 WorkBuddy 对话里问「列出当前任务」，它应该调到 `list_tasks`。

4. 建一个定时任务（每 10–30 分钟）：

```
调用 next_task 取一条任务；没有任务就直接结束，不要做别的；
有任务就按 note 里的要求执行，做完调用 report_task 回填，
evidence 写 结论 + 命令 + 退出码 + 改了哪些文件。

再调用 next_docsync 取一条文档同步；没有就结束；
按返回的指令执行，写完调用 report_docsync（done / failed + 证据）。
```

## 本机自测（不经过 WorkBuddy）

```powershell
node scripts/smoke.mjs        # 面板/队列/连接器契约
```

## 注意

- 服务器只读写 `data/` 下约定的文件；WorkBuddy 里「信任」后才会被调用。
- 文档指令不再写死在 bridge 里：由连接器的 `match` / `describe` 决定；`add_task` 命中即拒建。
- 任务里不要写真实密码；证据里也别写。
- 如果 WorkBuddy 报格式错误，选中上 `"type": "stdio"` 再试一次（不同版本对 stdio 的推断方式不一样）。
