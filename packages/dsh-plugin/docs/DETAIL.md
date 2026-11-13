# LosFlow 驾驶舱

在 DSH 右侧栏加一个 **LosFlow** 页签，点开就是驾驶舱（任务池、任务、文档同步状态、授权队列）。

## 使用

1. 打开任意会话，展开右侧栏（`Ctrl+J` 或会话标题栏右角的展开按钮）。
2. 右侧栏的引导页里点 **LosFlow**，或者用页签条的 `+` 选择它。
3. 面板里就是 `http://127.0.0.1:8899/app/` 那一页。

## 前提

驾驶舱服务要先跑起来：

```powershell
node D:\PROJECT\Ds\tools\dashboard\server.mjs 8899
```

服务没起来时页签里会显示连接失败，起来后刷新一下页签即可。

## 实现说明

`client.js` 通过 `ctx.sidebarRightTabs.register()` 注册 `kind = losflow` 的页签类型，
再用 `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ... })` 提供页签内容。
内容是内嵌的 iframe，所以它是一份独立的页面样式，不跟随 DSH 主题；后续会换成原生 React 面板。
