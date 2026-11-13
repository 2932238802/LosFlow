# dsh-cockpit

DSH 驾驶舱前端（Vue 3 + Vite）。数据来自本地 `tools/dashboard/server.mjs`。

## 开发

```bash
npm install
npm run dev      # http://127.0.0.1:5174 ，/api 与 /events 代理到 8899
```

## 构建

```bash
npm run build    # 产物 dist/，由 server.mjs 托管在 http://127.0.0.1:8899/app/
```

## 页面结构

- **Authorize**：Claude Code 被拒的命令，批准后记账并自动重派
- **Pool**：任务池，三条确认（细则/流程/授权）→ 拆分 → 推送到腾讯文档
- **Claude Code**：`/events/claude` SSE 实时事件（init / say / tool / result / done）
- **WorkBuddy**：`/events/workbuddy` SSE，MCP 调用流 + 当前执行中的任务
- **Tasks**：任务表

`?static=1` 时不连 SSE，用于无头截图。