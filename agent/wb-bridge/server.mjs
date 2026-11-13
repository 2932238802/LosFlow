#!/usr/bin/env node
// wb-bridge: 给 WorkBuddy 用的本地 MCP server（stdio，JSON-RPC 2.0，零依赖）。
//
// 它把 DSH 这边的任务表（D:\PROJECT\Ds\_progress\Vesta.tasks.json，与 taskboard.ps1 同一份）
// 暴露成 4 个工具，WorkBuddy 的 agent 可以：取活 → 干 → 交活。
//
// 工具：
//   list_tasks            列出全部任务
//   next_task             取第一个 todo，标记 doing，返回它
//   report_task           按 id 回填 done / blocked，附证据
//   add_task              新增一条任务
//
// 环境变量（可选）：
//   WB_TASKS_FILE   任务表路径，默认 D:\PROJECT\Ds\_progress\Vesta.tasks.json

import { createInterface } from "node:readline";
import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadPaths } from "../../server/paths.mjs";
import { mutate } from "../../server/store.mjs";
import * as docsync from "../../server/docsync.mjs";
import * as connectors from "../../server/connector-host.mjs";

const PATHS = loadPaths();
await connectors.initConnectors(PATHS);
docsync.initDocsync(PATHS, { worker: false });

const TASKS_FILE =
  process.env.WB_TASKS_FILE || join(PATHS.dataDir, "Vesta.tasks.json");

// 调用日志：确认 WorkBuddy 到底有没有真的调过来
const CALL_LOG =
  process.env.WB_CALL_LOG || join(PATHS.dataDir, "calls.jsonl");

function logCall(entry) {
  try {
    const dir = dirname(CALL_LOG);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(
      CALL_LOG,
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry }) + "\n",
      "utf8"
    );
  } catch {
    /* 日志失败不影响主流程 */
  }
}

const log = (...a) => process.stderr.write(`[wb-bridge] ${a.join(" ")}\n`);

function loadTasks() {
  if (!existsSync(TASKS_FILE)) return [];
  try {
    const raw = readFileSync(TASKS_FILE, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    log("load failed:", err.message);
    return [];
  }
}

function saveTasks(tasks) {
  try {
    const dir = dirname(TASKS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return mutate(TASKS_FILE, () => tasks);
}

function nowIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 文档同步类任务不占任务表：docOnly 标记的、或 WorkBuddy 名下带文档操作指令的，
// 都不该被 next_task 当成普通任务取走。
function isDocOnlyTask(t) {
  if (t.docOnly) return true;
  return (
    (t.owner || "") === "workbuddy" &&
    docsync.isDocSyncInstruction([t.subject, t.note].filter(Boolean).join("\n"))
  );
}

function renderTasks(tasks) {
  if (!tasks.length) return "（任务表为空）";
  return tasks
    .map((t) => {
      const ev = t.evidence ? ` | 证据: ${t.evidence}` : "";
      const note = t.note ? ` | 备注: ${t.note}` : "";
      return `#${t.id} [${t.status}] ${t.subject}${note}${ev}`;
    })
    .join("\n");
}

const tools = [
  {
    name: "list_tasks",
    description:
      "列出当前全部任务及其状态（todo/doing/done/blocked）、备注与证据。只读。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      const tasks = loadTasks();
      return `${tasks.length} 条任务：\n${renderTasks(tasks)}`;
    },
  },
  {
    name: "next_task",
    description:
      "取第一个 status=todo 的任务，标记为 doing 并返回。传 owner 只取分配给该执行体的任务（例如 owner=workbuddy），避免拿到别人的活。返回「暂无待办任务」表示没有活。",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "只取这个 owner 的任务；省略则不限",
        },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const tasks = loadTasks();
      const want = args && args.owner ? String(args.owner) : "";
      const t = tasks.find(
        (x) =>
          x.status === "todo" &&
          !isDocOnlyTask(x) &&
          (!want || String(x.owner || "") === want)
      );
      if (!t) return want ? `暂无分配给 ${want} 的待办任务。` : "暂无待办任务。";
      t.status = "doing";
      t.updatedAt = Date.now();
      await saveTasks(tasks);
      return [
        `任务 #${t.id}: ${t.subject}`,
        t.note ? `备注: ${t.note}` : "",
        t.owner ? `归属: ${t.owner}` : "",
        "（已标记为 doing）",
      ]
        .filter(Boolean)
        .join("\n");
    },
  },
  {
    name: "report_task",
    description:
      "回报一条任务的结果。status 只能是 done 或 blocked；evidence 写结论、命令、退出码、改了哪些文件。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "任务 id" },
        status: { type: "string", enum: ["done", "blocked"] },
        evidence: { type: "string", description: "结论 + 证据 + 落盘路径" },
      },
      required: ["id", "status"],
      additionalProperties: false,
    },
    run: async (args) => {
      const tasks = loadTasks();
      const t = tasks.find((x) => String(x.id) === String(args.id));
      if (!t) return `找不到任务 #${args.id}`;
      t.status = args.status;
      if (args.evidence) t.evidence = args.evidence;
      t.updatedAt = Date.now();
      await saveTasks(tasks);
      return `任务 #${t.id} 已回填为 ${t.status}。`;
    },
  },
  {
    name: "next_docsync",
    description:
      "取一条待写的文档同步任务（异步队列），标记为 running 并返回要写的内容。可传 connector 只取某个连接器的活；返回第一行带 connector: <id>。没有任务时返回「暂无文档同步任务」。写完必须调 report_docsync 回执。",
    inputSchema: {
      type: "object",
      properties: {
        connector: { type: "string", description: "只取这个连接器的任务（可选，例如 tencent-wb）" },
      },
      additionalProperties: false,
    },
    run: async (args = {}) => {
      const j = await docsync.nextJob(args.connector || "");
      if (!j) return "暂无文档同步任务。";
      return docsync.describeJob(j);
    },
  },
  {
    name: "report_docsync",
    description:
      "回执一条文档同步（异步回调）。status 只能是 done 或 failed；failed 要写清卡在哪一步与报错原文，队列会自动重试。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "文档同步 id（next_docsync 返回的 #dX）" },
        status: { type: "string", enum: ["done", "failed"] },
        evidence: { type: "string", description: "写到了哪一行、读回校验结果、或失败原因" },
      },
      required: ["id", "status"],
      additionalProperties: false,
    },
    run: async (args) => {
      const j = await docsync.report({ id: args.id, status: args.status, evidence: args.evidence });
      return `文档同步 #${j.id} → ${j.status}（已试 ${j.attempts} 次）`;
    },
  },
  {
    name: "add_task",
    description: "新增一条任务（默认 status=todo）。写腾讯文档的操作指令会被拒绝——那类活走文档同步队列。",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "任务标题" },
        note: { type: "string", description: "补充说明（可选）" },
        owner: { type: "string", description: "归属（可选）" },
      },
      required: ["subject"],
      additionalProperties: false,
    },
    run: async (args) => {
      // 写腾讯文档是默认后台行为，走 docsync 队列，不占任务表、不进终端
      if (docsync.isDocSyncInstruction([args.subject, args.note].filter(Boolean).join("\n"))) {
        throw new Error(
          "拒绝建任务：这是腾讯文档操作指令。写表格请走文档同步队列（next_docsync → 写完 → report_docsync），它不占任务行、不进终端。"
        );
      }
      const tasks = loadTasks();
      const maxId = tasks.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
      const t = {
        id: String(maxId + 1),
        subject: args.subject,
        owner: args.owner || "",
        note: args.note || "",
        status: "todo",
        evidence: "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      tasks.push(t);
      await saveTasks(tasks);
      return `已新增任务 #${t.id}: ${t.subject}（${nowIso()}）`;
    },
  },
];

const PROTOCOL_FALLBACK = "2024-11-05";

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  if (method === "initialize") {
    const requested = params?.protocolVersion;
    logCall({ kind: "initialize", client: params?.clientInfo?.name || "", protocol: requested || "" });
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: requested || PROTOCOL_FALLBACK,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "wb-bridge", version: "1.0.0" },
      },
    });
    return;
  }

  if (method === "notifications/initialized" || method === "initialized") return;

  if (method === "tools/list") {
    const canSync = docsync.hasExecutors();
    const visible = tools.filter((t) => !["next_docsync", "report_docsync"].includes(t.name) || canSync);
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: visible.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
    });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `unknown tool: ${name}` },
      });
      return;
    }
    try {
      const text = await tool.run(args);
      // 记下这次调用涉及的 task id：报表靠它知道 WorkBuddy 取走了哪条、回了哪条
      let taskId = args && args.id ? String(args.id) : "";
      if (!taskId && name === "next_task") {
        const m = String(text).match(/任务 #(\d+)/);
        if (m) taskId = m[1];
      }
      logCall({ kind: "tool", tool: name, args, ok: true, taskId });
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    } catch (err) {
      logCall({ kind: "tool", tool: name, args, ok: false, error: err.message });
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `错误: ${err.message}` }], isError: true },
      });
    }
    return;
  }

  if (method === "ping") {
    if (isRequest) send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (isRequest) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `method not found: ${method}` },
    });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    log("bad json:", s.slice(0, 120));
    return;
  }
  handle(msg).catch((err) => log("handler failed:", err.message));
});
rl.on("close", () => process.exit(0));

log(`ready, tasks file: ${TASKS_FILE}`);
