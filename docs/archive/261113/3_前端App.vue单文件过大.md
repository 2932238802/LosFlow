# 3 · 前端 `App.vue` 单文件过大，需要按视图拆开

| 项 | 内容 |
| --- | --- |
| 编号 | 3 |
| 日期 | 2026-11-13 |
| 项目 | LosFlow（`D:\PROJECT\LosFlow`） |
| 类型 | 前端结构 / 可维护性 |
| 状态 | 已完成（2026-11-13 分步拆分；CSS 仍为全局） |
| 提出 | 杰哥（「拆前端，现在前端有点太大了」） |
| 涉及文件 | `web/src/App.vue`、`web/src/style.css`、`web/src/term.css`、`server/index.html`、`docs/architecture.md` |

## 一句话结论

整个驾驶舱前端是一个 918 行的单文件组件：script 526 行 + template 391 行，一个文件里同时装着 6 个视图、5 个弹层、41 个 ref、24 个接口调用和全部业务动作。**不是「行数多」本身难受，而是没有边界**——改任何一个视图都要读全文，状态谁都能改，弹层骨架抄了 5 遍。

## 现状（2026-11-13 实测）

```
web/src/
├─ App.vue      918 行 / 44,820 字节     ← 全部逻辑 + 全部模板
├─ main.ts        5 行
├─ style.css    261 行 / 15,458 字节
└─ term.css      80 行 /  5,446 字节
（没有 components/、没有 views/、没有 store/、没有 types.ts）
```

`App.vue` 内部分块（行号为当前实际行号）：

| 块 | 行号 | 行数 | 内容 |
| --- | --- | --- | --- |
| 类型声明 | 4–19 | 16 | `PoolItem` / `Task` / `Approval` / `State` / `RawLine` 手写在组件里 |
| 视图枚举 | 21–30 | 10 | `View`、`VIEWS`、`loadView()`（localStorage 记忆） |
| 全局 ref | 31–64 | 34 | `s`/`view`/`open`/`raws`/`wb`/`msg`/`busy`/`newTitle`/`split*`/`tpl*`/`proj*`/`threshold`/`cronPrompt`/`termOpen`…… |
| 终端滚动 | 66–102 | 37 | `termEls` 普通对象存 DOM、`termAtBottom`、两个 watch |
| 其余 ref | 103–107 | 5 | `sheet`/`nowMs`/`drafts`/`optInfo`/`runInfo` |
| 基础工具 | 109–134 | 26 | `draftOf`/`flash`/`post`/`refresh`/`loadRaw`/`toggleOpen` |
| computed + 终端动作 | 136–205 | 70 | 6 个列表 computed、`pct`、`runningElapsed`、`delRun`、`copyTerm`、`termTasks` |
| 展示辅助 | 207–258 | 52 | `stageInfo`/`docText`/`fmtBytes`/`purge`/`cmdText`/`waitedFor` |
| 草稿/阈值/定时 | 260–288 | 29 | `optimizeDraft`/`saveThreshold`/`buildCronPrompt` |
| 项目管理 | 289–321 | 33 | `openProj`/`browse`/`saveProj`/`delProj`/`pickProject` |
| 池子 | 322–355 | 34 | `add`/`removePool`/`doPush` |
| 拆分弹层 | 356–407 | 52 | `openSplit`/`aiSplit`/`applySplit`/`addManualLine` |
| 模板设置 | 408–421 | 14 | `openTpl`/`saveTpl` |
| 任务动作 | 422–455 | 34 | `dispatchTask`/`stopRun`/`delTask`/`focusNew`/`setRepo` |
| 其余动作 | 456–509 | 54 | `optimizePrompt`/`genDocs`/`splitTask`/`nudge`/`cleanup`/`approve`/`reject` |
| 生命周期 | 511–526 | 16 | 5s 轮询 + 1s 心跳 + 2s 日志刷新 + EventSource |
| **template 合计** | 528–918 | 391 | 侧栏 19 + 任务 106 + 设置 59 + 终端 61 + 已完成 20 + WB 11 + 文档 4 + 弹层 100 |

规模指标：**6 个视图**（任务/终端/已完成/WorkBuddy/文档/设置）、**5 个弹层**（选项目 817、加项目 833、拆分 858、优化 SKILL 890、结果 sheet 904）、**24 个 `POST/GET` 接口**（另有 `/api/task/raw`、`/api/wsl/ls` 两个 GET 和 1 条 `/events/workbuddy` SSE）、**6 处 `as any`**（115/116/147/189/190/218）、**27 处模板内联 `style=`**。

## 问题（为什么「大」是真问题）

1. **加一个视图要动 6 处**：`View` 类型（21）→ `VIEWS`（22）→ 侧栏按钮（532–539）→ `main` 里的 `v-if` 分支（550 起）→ 新增一批全局 ref → 往 `style.css` 里塞样式。少改一处就是静默失效（比如忘了加进 `VIEWS`，刷新后 `loadView()` 直接回落 `tasks`）。
2. **状态没有归属**：41 个 ref 平铺在同一个 `<script setup>` 作用域里，`termOpen`、`drafts`、`newTitle`、`projDirs` 谁都能读能写。读代码时看不出「这个 state 属于哪个功能」，也拦不住跨功能乱改。
3. **弹层骨架抄了 5 遍**：`<div class="overlay" @click.self="xxx=false"><div class="sheet">…</div></div>` 在 817/833/858/890/904 各写一次，关闭逻辑、标题、底部按钮各不相同但结构完全一样。改一次滚动/点击穿透/层级 bug 要改 5 处。
4. **有两处隐式 DOM 契约，拆分时必断**：
   - `termEls` 是普通对象（67），靠模板里的 `:ref="(el) => setTermEl(t.id, el)"`（749）把 DOM 塞回去——组件化后 ref 落在子组件内部，这段会直接失效；
   - `focusNew()`（444–450）用 `document.getElementById("newTitleInput")` 跨区拿节点，靠的是「这个 id 恰好在这个文件里」。
5. **类型没有单一来源**：`Task`/`PoolItem` 手写在 4–19 行，而服务端契约写在 `docs/architecture.md:47`；两边各说各话，于是出现 `(t as any).docSync`、`(s.value as any)?.terminals`、`it.project`（`PoolItem` 上根本没有 `project` 字段）这类绕过。
6. **死代码混在里面**：`pointOpen`（62）、`subs`（42）、`editing`（42）声明之后从未使用（实测各自只出现 1–2 次，都是声明本身）。918 行里看不出哪些是活的。

## 另一处：仓库里其实有两套前端

| 入口 | 文件 | 状态 |
| --- | --- | --- |
| `/app/` | `web/`（Vue SPA → `web/dist`，`server.mjs:803-827` 托管） | 真在用：README、`packages/dsh-plugin` 的 iframe 都指这里 |
| `/` | `server/index.html`（296 行内联 CSS+JS 的「FLOW」页，`server.mjs:830-838` 托管） | 已废：它调的 `/api/pool/split` 服务端**没有这个路由**（只有 `pool/suggest` / `pool/apply`），也完全没有 `/api/task/*`，连派单都做不了 |

`server/index.html` 是早期原型，但至今仍被托管、仍会被人误当成主页打开。拆前端时应一并处置：删掉，或改成跳 `/app/` 的 302。

## 拆分方案

原则：**一步一提交，每步 `npm run build` + `npm run smoke` 都绿，拆分提交只搬不改**（行为改动单独一个提交，方便 review 和回滚）。

### 目标结构（12–25 个文件，视分批程度）

```
web/src/
├─ main.ts                      不动
├─ App.vue                      shell：侧栏 + 视图路由 + 全局 toast（目标 ≤120 行）
├─ types.ts                     与 server 契约对齐的 PoolItem/Task/Approval/State/View
├─ api.ts                       get()/post()：统一 x-dash、错误体提取、超时
├─ utils/format.ts              fmtBytes / waitedFor / pct / stageInfo / docText / cmdText
├─ store/                       纯 composable，不引 Pinia（保持零依赖）
│   ├─ useAppState.ts           5s 轮询 + 1s 心跳 + localStorage 视图记忆 + init()
│   ├─ useToast.ts              msg / err / flash
│   ├─ useTasks.ts              dispatch / continue / stop / delete / repo / docs / nudge / optimize
│   ├─ usePool.ts               add / remove / push / suggest / apply
│   ├─ useTerminal.ts           raws / termTasks / termOpen / termAtBottom / 滚动 / delRun / copyTerm
│   └─ useProjects.ts           browse / add / remove / pick
├─ components/
│   ├─ AppSidebar.vue
│   ├─ SheetShell.vue           5 个弹层共用的 overlay 壳
│   ├─ TaskCard.vue
│   ├─ PoolPanel.vue
│   ├─ NewTaskBox.vue
│   ├─ TerminalCard.vue
│   └─ AuthRail.vue
├─ views/
│   ├─ TasksView.vue  TerminalsView.vue  DoneView.vue  SettingsView.vue  WbView.vue
└─ dialogs/
    ProjectPicker.vue  ProjectDialog.vue  SplitDialog.vue  TemplateDialog.vue  ResultSheet.vue
```

「文档」视图只有 4 行 iframe（811–814），不值得单独开文件，留在 `App.vue`。

### 分步落地

| 步 | 做什么 | `App.vue` 行数 | 验证 |
| --- | --- | --- | --- |
| 0 | 删 `pointOpen`/`subs`/`editing` 三个死变量；处置 `server/index.html` | 918 → 约 910 | build + smoke；`git diff` 只删不加 |
| 1 | 抽 `types.ts` + `api.ts`（纯搬运，`post()` 从 118 行搬走） | 910 → 约 820 | build；除 import 外 diff 为空 |
| 2 | 抽 `SheetShell.vue` + 5 个 `dialogs/`，模板里只剩 5 个 `<XxxDialog v-if>` | 820 → 约 700 | build + 逐个开关 5 个弹层 |
| 3 | 状态分域：`store/` 6 个 composable（先 `useToast`/`useAppState`，再按域搬动作） | 700 → 约 350（script 剩 import + 少量 local state） | build + 重启后端手测派单/终端 |
| 4 | 按视图切 `views/`，一次一个视图一个提交（建议顺序：设置 → 已完成 → WB → 终端 → 任务） | 350 → 约 120 | build + 逐页点 |
| 5 | CSS 按视图拆（`styles/` 或各 `.vue` 内 `<style scoped>`），`main.ts` 只引 `tokens.css` | — | build；对比 `dist/*.css` 体积 |

第 3 步与第 4 步可以交换。本方案坚持**先状态后视图**的理由：视图一旦先行，每个视图都得靠 props/emits 把状态穿下去，拆完还得再改一遍；先把状态提到 composable，视图拆分就退化成纯模板搬运（`<script setup>` 只剩 `import` 三五行），diff 好审很多。

### 现有块 → 目标文件（逐块映射）

| 现 `App.vue` | 去哪 |
| --- | --- |
| 4–19 类型 | `types.ts` |
| 21–30 View/VIEWS/loadView | `types.ts` + `store/useAppState.ts` |
| 31–64 全局 ref | 按域拆到 `store/*`；`view` 留在 `App.vue` |
| 64、66–102 终端展开与滚动 | `store/useTerminal.ts` + `components/TerminalCard.vue`（滚动状态留在 store，切页不丢） |
| 103–107 sheet / nowMs / drafts | `nowMs`→`useAppState`；`drafts`→`useTasks`；`sheet`→`useToast` 或独立 `useSheet` |
| 109–134 post / refresh / loadRaw | `api.ts` + `useAppState` + `useTerminal` |
| 136–205 computed、delRun、copyTerm、termTasks | `useTasks` / `useTerminal`；`pct` 等纯函数进 `utils/format.ts` |
| 207–258 stageInfo / docText / fmtBytes / cmdText / waitedFor | `utils/format.ts`；`purge` → `useTasks` 或 `useSettings` |
| 260–288 optimizeDraft / saveThreshold / buildCronPrompt | `useTasks` + `useSettings` |
| 289–321 项目管理 | `store/useProjects.ts` |
| 322–355、356–407 池子与拆分 | `store/usePool.ts` |
| 408–421 模板设置 | `dialogs/TemplateDialog.vue` + `useSettings` |
| 422–455、456–509 任务动作 | `store/useTasks.ts`（`focusNew` 改显式 ref） |
| 511–526 生命周期 | `useAppState.init()` + `App.vue` 的 `onMounted` |
| 528–546 shell + 侧栏 | `App.vue` + `components/AppSidebar.vue` |
| 549–654 任务视图 | `views/TasksView.vue` + `TaskCard` / `PoolPanel` / `NewTaskBox` |
| 656–714 设置 | `views/SettingsView.vue` |
| 716–776 终端 | `views/TerminalsView.vue` + `TerminalCard` / `AuthRail` |
| 778–797 / 799–809 | `views/DoneView.vue` / `views/WbView.vue` |
| 811–814 文档 | 留在 `App.vue` |
| 817–916 五个弹层 | `dialogs/*` + `SheetShell.vue` |

## 风险与注意（拆分时最容易踩的）

1. **`termEls` 的模板 ref**（67、86–89、749）：必须跟着 `TerminalCard.vue` 一起搬，或者在 store 里改成 `ref<HTMLElement>` 映射；不改就会静默失效——终端不再自动判断「是否在底部」。
2. **`focusNew()`**（444–450）：`getElementById` 依赖 id 恰好同文件。改 `NewTaskBox` 暴露 `defineExpose({ focus })`，父组件拿组件 ref 调，别再靠全局 id。
3. **`drafts` 是 `reactive`**（105）：`TaskCard` 和 `dispatchTask` 都读写。拆开后必须提到 store（本来就是跨卡片共享），否则要么传 prop 丢响应性，要么每张卡自己存一份导致派单取错文本。
4. **轮询定时器**（518–523）：2s 那个读 `view` 和 `termTasks`。它应该搬进 `useTerminal`，别让 `App.vue` 反过来依赖子组件状态。
5. **`v-if` 会销毁重建视图**：现有展开态（`termOpen`、`open`）都存在 ref 里所以切页还在。搬到组件内部状态就会丢，务必留在 store。
6. **构建与托管别动**：`vite.config.ts` 的 `base: "./"` 和 `outDir: "dist"` 不要改，`server.mjs:811-821` 靠 `web/dist/index.html` 提供 `/app/`；`scripts/smoke.mjs:46-47` 有一条 `GET /app/` 断言兜底。
7. **文档要跟着改**：`docs/architecture.md:35-43` 的前端边界表和「拆分方向（待做）」要换成实际结构；`README.md:84`「前端只有一个入口 `web/src/App.vue`」拆完就不成立了。

## 验收标准

- `App.vue` ≤ 150 行，里面没有业务动作、没有接口地址；
- 新增的每个文件 ≤ 250 行（`views/` 可放宽到 300）；
- `npm run build` 通过，`web/dist/index.html` 正常产出；
- `npm run smoke` 全绿（含 `GET /app/`）；
- 6 个视图逐页手点无回归：
  - 任务：展开卡片 / 优化提示词 / 派单 / 续接 / 删任务 / 池子拆分 / 推入（含优先级）/ 加入池 / 新建项目；
  - 终端：展开收起 / 全屏 / 复制 / 「↓ 底部」/ 删除会话 / 右侧授权批准与拒绝；
  - 已完成、WorkBuddy、文档 iframe、设置（清理 24h/7d/全清、项目增删、阈值保存、定时指令生成）；
- 5 个弹层逐个开关正常，点遮罩能关；
- 刷新/重开仍停在原视图（`localStorage.losflow.view`）；
- 拆分提交的 `git diff` 里只有搬运，行为类改动单独成提交。

## 待确认（动手前先定）

1. 先切状态还是先切视图？本方案推荐先状态（第 3 步）后视图（第 4 步），理由见上文。
2. 引不引 Pinia？推荐**不引**，继续用 composable 保持零依赖；只有需要 devtools 时间旅行或跨页持久化时才值得引。
3. `server/index.html` 直接删掉，还是保留成跳 `/app/` 的 302？
4. 要不要顺手补 `vue-tsc --noEmit` 类型检查脚本？现在 `web/package.json` 只有 dev/build/preview，没有 type-check，那 6 处 `as any` 才一直没被抓出来。
5. 提交粒度：一步一 commit，还是最后压成一个「拆前端」？

## 参考

- `docs/architecture.md:33-43`（已经写了「拆分方向（待做）」，本文把它具体化到文件与行号）
- `README.md:84`、`docs/api.md`
- `scripts/smoke.mjs`（冒烟断言清单）
- 本记录只读代码核对（2026-11-13），未改动任何文件

## 变更记录

- 2026-11-13 建档，问题登记 + 拆分方案，未实施。
- 2026-11-13 实施完成（按「一步一提交」的思路分阶段落地，本轮一次改完后再统一验证）：
  - 基础层：新增 `types.ts`（与服务端契约对齐）、`api.ts`（`getJSON` / `post`）、`utils/format.ts`（纯展示函数）。
  - 状态层：`store/` 下 10 个 composable 单例——`useAppState` / `useView` / `useTasks` / `useMark` / `usePool` / `useProjects` / `useTerminal` / `useSettings` / `useWb` / `useLifecycle`（另加 `useFocus`、`useToast`）。跨视图状态全部上提，`v-if` 切页不再丢展开态、终端滚动、草稿与弹层。
  - 组件层：`AppSidebar`、`SheetShell`、`TaskCard`、`PoolPanel`、`NewTaskBox`、`TerminalCard`、`AuthRail`。
  - 视图层：`TasksView` / `TerminalsView` / `DoneView` / `WbView` / `SettingsView`；「文档」iframe 只有一行，留在 `App.vue`。
  - 弹层：`dialogs/` 下 6 个（`ProjectPicker` / `ProjectDialog` / `SplitDialog` / `TemplateDialog` / `MarkDialog` / `ResultSheet`），骨架统一走 `SheetShell`。
  - 删死代码：`pointOpen` / `subs` / `editing` / 未使用的 `termRuns`；`focusNew` 从 `getElementById` 改为 `NewTaskBox` 注册聚焦函数（`store/useFocus.ts`）。
  - `App.vue` 从 1075 行降到约 55 行；新增文件均在 250 行以内（views 最大约 70 行）。
  - `server/index.html`：`/` 与 `/index.html` 改为 302 到 `/app/`，原型页不再托管；`scripts/smoke.mjs` 增加该跳转断言。
  - CSS 未按视图拆：`style.css` / `term.css` 保留全局（共享 tokens、卡片、按钮、弹层样式多，拆开反而重复）；后续真要拆再按视图 `<style scoped>` 搬。
  - 验证：`npm run build`、`npm run smoke` 通过；无头浏览器回归覆盖侧栏层级、任务展开、拆分/推入/选项目/SKILL/标记完成 5 类弹层、终端展开与标记面板、设置页、WorkBuddy/已完成切换、刷新记忆，且无运行时异常。数据用 `.tmp/` 下的临时副本，未动 `data/`。
