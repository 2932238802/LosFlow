# 运行手册

## 起停

```powershell
npm start                 # 前台跑，Ctrl+C 停
node server/server.mjs 8900   # 换端口

# 后台常驻（Windows）
Start-Process node -ArgumentList 'server/server.mjs' -WorkingDirectory D:\PROJECT\LosFlow -WindowStyle Hidden
```

前端改了要 `npm run build`（服务直接读 `web/dist`，不用重启）。

### 更新（`update.bat` / `update.sh`）

```powershell
update.bat                   # 构建 + 类型检查 + 单测 + 冒烟 + 接管端口（默认）
update.bat --check-only      # 只跑检查和构建，不重启服务
update.bat --no-check        # 跳过检查，直接构建 + 重启
update.bat --no-build        # 跳过构建
update.bat --force           # 端口被别的进程占 / 有任务在跑时也强制重启
```

- 检查使用**隔离的数据目录**和临时端口，不会和正在跑的服务抢 `data/`。
- 有任务正在跑（`tasks[].running` / `starting`）时默认**拒绝重启**，避免打断实时授权与 SSE；`--force` 可跳过。
- 重启后脚本会核对：端口监听者确实是本仓库的 `server.mjs`，`/app/` 返回的产物哈希与 `web/dist` 一致；不一致直接报错。
- 日志与 pid 按端口落盘：`.tmp/dashboard-<port>.out.log`、`.err.log`、`.pid`。

### Windows 授权提醒

- 新授权请求入队时，服务端 spawn `agent/win-notify.ps1`（`NotifyIcon` 气球 + 声音）；8s 内合并计数，20s 未处理再响一次。
- 服务必须跑在**登录会话**里（`npm start`）。做成 Windows 服务 / session 0 时气球不会出现在桌面上。
- 关闭：`losflow.config.json` 的 `notify.enabled=false`（或环境变量 `LOSFLOW_NOTIFY=0`）；设置页会显示「Windows 提醒：开 / 关 / 不可用（原因）」。
- 非 Windows 平台不弹、不报错。

## 常见故障

| 现象 | 先查 |
| --- | --- |
| 面板显示「终端 0 在跑」但有 claude 在跑 | WSL 里 `bash server/scan-terminals.sh` 能否列出；`/tmp/cc-*.pid` 是否还在。Windows 派单看 `data/runstate/*.json` 的 `pid` 是否还活着（`Get-Process -Id <pid>`） |
| 派单报乱码 | `agent/claude-dispatch.ps1` 顶部的 UTF-8 prologue 是否还在 |
| 文档同步一直 pending | WorkBuddy 侧有没有建定时任务调 `next_docsync`；`data/calls.jsonl` 最近调用时间 |
| 授权不出现 | 那次派单是否真的产生了 `permission_denials`；`data/approvals.json`；`/api/state.notify` 是否可用 |
| 授权卡片位置不对 / 没有提醒 | 授权卡在会话右上角悬浮（当前会话排最前，其他会话可「切过去」）；Windows 提醒看设置页状态与是否跑在登录会话 |
| 页面空白/黑屏 | 浏览器控制台；多半是模板里访问了不存在的字段 |
| 端口被占 | `Get-NetTCPConnection -LocalPort 8899`，先确认不是别的服务 |

## 数据维护

- **清历史**：面板 设置 → 历史会话；或 `POST /api/maintenance/purge {hours}`。
- **删单条会话**：终端卡片「删除」；接口 `POST /api/run/delete {id,taskId}`。
- **迁移机器**：拷整个仓库 + `data/`，改 `losflow.config.json`（WSL 发行版、默认环境、Windows claude 路径、node 路径、端口）。

## 安全

- 只监听 `127.0.0.1`，不要暴露公网。
- `data/` 里有完整答卷之外的派单正文与回执，别提交、别外发。
- 授权批准会把规则写进 `data/allowlist.json` 并**自动重派一次**，注意花费。
