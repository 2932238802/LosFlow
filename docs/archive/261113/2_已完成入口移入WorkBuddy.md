# 2 · 「已完成」入口应归到「WorkBuddy」下面

| 项 | 内容 |
| --- | --- |
| 编号 | 2 |
| 日期 | 2026-11-13 |
| 项目 | LosFlow（`D:\PROJECT\LosFlow`） |
| 类型 | UI / 侧边栏导航 |
| 状态 | 已实施（2026-11-13 实施，同日按杰哥意见改为钉在侧栏底部） |
| 提出 | 杰哥（使用中发现） |
| 涉及文件 | `web/src/App.vue`（导航 532–539 行；「已完成」视图 779–797；WorkBuddy 视图 799–809） |

## 背景

使用分工：在「任务」里布置任务、做分析；在「终端」里正式干活。

## 现象

侧边栏目前是 6 个平级入口，顺序为：

```
任务 → 终端 → 已完成 → WorkBuddy → 文档 → 设置
```

`web/src/App.vue:532-539` 里 6 个 `<button>` 平铺在 `nav.nav` 容器中，「已完成」和「WorkBuddy」是同一级。

## 期望

「已完成」不再作为一级入口，而是挂到「WorkBuddy」下面，作为它的子项。即一级入口变为：

```
任务 → 终端 → WorkBuddy → 文档 → 设置
                  └─ 已完成
```

## 影响

- 一级入口里「已完成」（任务归档 + 归档的池子）和「WorkBuddy」（MCP 调用记录）语义都偏「干完之后」，平铺让层级变平，容易点错。
- 「已完成」收进 WorkBuddy 后，任务、终端这两个高频入口更靠前、更突出。

## 待确认（实施前先定）

1. 点「WorkBuddy」一级入口时，默认内容仍是现在的「MCP 调用记录」，还是直接进「已完成」？
2. 「已完成」的展开方式：常驻二级（一直显示缩进的子项），还是点 WorkBuddy 才展开？
3. 徽标怎么放：`doneTasks.length` 显示在「已完成」子项上，WorkBuddy 一级仍显示 `wb.length`？

## 实现建议（方案，未动代码）

1. 导航从写死的 6 个 `<button>` 改成数据驱动（数组 + `v-for`），WorkBuddy 项带 `children: ["done"]`。
2. `View` 类型不变（`"tasks" | "terminals" | "done" | "wb" | "docs" | "settings"`），`done` / `wb` 两个视图都保留，切换仍走 `view` ref；`localStorage` 记忆与 `VIEWS` 校验照旧。
3. 样式加 `.nav-group` / `.nav-sub`，子项缩进、字号略小。
4. 动前端后跑 `npm run build`，再跑 `npm run smoke`。

## 验收

- 侧边栏一级只剩 任务 / 终端 / WorkBuddy / 文档 / 设置。
- 「已完成」出现在 WorkBuddy 下面，点进去仍是现有「已完成」页（任务列表 + 归档的池子两块内容不变）。
- 刷新/重开仍能记住停留页面（`localStorage`），旧的 `losflow.view=done` 仍可正常打开。
- 任务、终端、文档、设置四个视图行为不变。

## 变更记录

- 2026-11-13 建档（问题登记，未实施）。初版误编为 `1_`，因同目录已有 `1_终端跑完后无法推进任务.md`，按实际序列顺延为 `2_`。
- 2026-11-13 实施完成：
  - 侧栏改为数据驱动（`components/AppSidebar.vue` 的 `nav` 数组 + `v-for`），一级入口变为 任务 / 终端 / WorkBuddy / 文档 / 设置；「已完成」作为 WorkBuddy 的常驻二级项（`.nav-sub`）缩进显示。
  - 决策：点一级「WorkBuddy」仍默认进 MCP 调用记录；`done` / `wb` 两个 `View` 都保留，`localStorage.losflow.view=done` 仍可正常打开。
  - 徽标：WorkBuddy 一级显示 `wb.length`，已完成二级显示 `doneTasks.length`。
  - 样式：`style.css` 增加 `.nav-sub`（缩进 + 弱化），窄屏下取消缩进。
  - 验证：`npm run build`、`npm run smoke` 通过；无头浏览器回归确认侧栏顺序、二级入口、徽标、切页与刷新记忆均正常。
- 2026-11-13 改版（杰哥用后反馈「栏目顺序不对」）：
  - 「已完成」不再挂在 WorkBuddy 下面，也不再缩进；改为侧栏底部单独一条，钉在「$ 花费」上方（`AppSidebar.vue` 里 `nav` 只留 任务 / 终端 / WorkBuddy / 文档 / 设置，另起 `nav.nav-foot` 放「已完成」）。
  - 顺序定为：任务 → 终端 → WorkBuddy → 文档 → 设置 →（栏底分隔线）已完成 → $ 花费。
  - 样式：`style.css` 删掉不再使用的 `.nav-sub`，新增 `.nav-foot { margin-top: auto; padding-top: 14px; border-top }`，`.side-foot` 不再用 `margin-top: auto`；窄屏取消分隔线、花费行改横排。
  - 验证：`npm run build`、`npm run typecheck` 通过，`http://127.0.0.1:8899/app/` 已换上新产物。
