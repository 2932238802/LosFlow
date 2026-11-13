# 运行手册

## 起停

```powershell
npm start                 # 前台跑，Ctrl+C 停
node server/server.mjs 8900   # 换端口

# 后台常驻（Windows）
Start-Process node -ArgumentList 'server/server.mjs' -WorkingDirectory D:\PROJECT\LosFlow -WindowStyle Hidden
```

前端改了要 `npm run build`（服务直接读 `web/dist`，不用重启）。

## 常见故障

| 现象 | 先查 |
| --- | --- |
| 面板显示「终端 0 在跑」但有 claude 在跑 | WSL 里 `bash server/scan-terminals.sh` 能否列出；`/tmp/cc-*.pid` 是否还在 |
| 派单报乱码 | `agent/claude-dispatch.ps1` 顶部的 UTF-8 prologue 是否还在 |
| 文档同步一直 pending | WorkBuddy 侧有没有建定时任务调 `next_docsync`；`data/calls.jsonl` 最近调用时间 |
| 授权不出现 | 那次派单是否真的产生了 `permission_denials`；`data/approvals.json` |
| 页面空白/黑屏 | 浏览器控制台；多半是模板里访问了不存在的字段 |
| 端口被占 | `Get-NetTCPConnection -LocalPort 8899`，先确认不是别的服务 |

## 数据维护

- **清历史**：面板 设置 → 历史会话；或 `POST /api/maintenance/purge {hours}`。
- **删单条会话**：终端卡片「删除」；接口 `POST /api/run/delete {id,taskId}`。
- **迁移机器**：拷整个仓库 + `data/`，改 `losflow.config.json`（WSL 发行版、node 路径、端口）。

## 安全

- 只监听 `127.0.0.1`，不要暴露公网。
- `data/` 里有完整答卷之外的派单正文与回执，别提交、别外发。
- 授权批准会把规则写进 `data/allowlist.json` 并**自动重派一次**，注意花费。
