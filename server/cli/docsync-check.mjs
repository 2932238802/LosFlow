#!/usr/bin/env node
// docsync-check.mjs -- 给 taskboard.ps1 等脚本用的「是不是文档指令」判定。
//
// 用法：node server/cli/docsync-check.mjs "<text>"
// 退出码：1 = 是文档活（拒绝建任务），0 = 不是，2 = 判定失败。
//
// 只读连接器 manifest / 配置，不启动队列 worker、不写任何数据。
import { loadPaths } from "../paths.mjs";
import * as connectors from "../connector-host.mjs";

const text = process.argv.slice(2).join(" ");
try {
  const paths = loadPaths();
  await connectors.initConnectors(paths);
  process.exit(connectors.matchDocInstruction(text) ? 1 : 0);
} catch (e) {
  console.error(e && e.message ? e.message : String(e));
  process.exit(2);
}
