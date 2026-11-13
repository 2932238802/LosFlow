# wb-bridge · 让 WorkBuddy 来取活

一个本地 MCP server（stdio，零依赖）。WorkBuddy 通过「自定义连接器」接上它，就能：

```
DSH 写任务（taskboard.ps1 / progress.ps1）
        ↓  同一份 Vesta.tasks.json
wb-bridge 的 4 个工具  ←  WorkBuddy 的定时任务每 N 分钟调一次
        ↓
WorkBuddy 干活（本机执行，能碰腾讯文档），把结果回填
        ↓
DSH 用 taskboard.ps1 -List 看到结果
```

方向是 **WorkBuddy 主动来取**，所以不需要开放平台、不需要企业资质、不需要 API key。

## 四个工具

| 工具 | 作用 |
| --- | --- |
| `list_tasks` | 列出全部任务（只读） |
| `next_task` | 取第一个 `todo` 并标记 `doing` |
| `report_task` | 按 id 回填 `done` / `blocked` + 证据 |
| `add_task` | 新增任务 |

## 数据

只管一个文件：`D:\PROJECT\Ds\_progress\Vesta.tasks.json`
（和 `taskboard.ps1` 同一份，字段：`id / subject / owner / note / status / evidence / createdAt / updatedAt`）

可用环境变量 `WB_TASKS_FILE` 指向别的表。

## 接入步骤

1. `~/.workbuddy/mcp.json` 已写好（2026-11-13）：

```json
{
  "mcpServers": {
    "ds-taskboard": {
      "command": "D:\\SOFT\\nodejs\\node.exe",
      "args": ["D:\\PROJECT\\Ds\\tools\\wb-bridge\\server.mjs"]
    }
  }
}
```

2. 打开 WorkBuddy → 连接器管理 → 右上角「自定义连接器」→ 给 `ds-taskboard` 点一次「信任」。
   不点不生效，这一步只能人做。

3. 验证：在 WorkBuddy 对话里问「列出当前任务」，它应该调到 `list_tasks`。

4. 建一个定时任务（每 10–30 分钟）：

```
调用 next_task 取一条任务；
没有任务就直接结束，不要做别的；
有任务就按 note 里的要求执行，做完调用 report_task 回填，
evidence 写 结论 + 命令 + 退出码 + 改了哪些文件。
```

## 本机自测（不经过 WorkBuddy）

```powershell
node D:\Temp\test-mcp.mjs     # 握手 + tools/list + list_tasks
```

预期：`tools: list_tasks, next_task, report_task, add_task`，并打印任务表内容。

## 注意

- 服务器只读写那一个 JSON，不碰别的东西；`WorkBuddy` 里「信任」后才会被调用。
- 任务里不要写真实密码；证据里也别写。
- 如果 WorkBuddy 报格式错误，选中上「type": "stdio"` 再试一次（不同版本对 stdio 的推断方式不一样）。
