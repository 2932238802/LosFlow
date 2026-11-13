// smoke.mjs -- 冒烟：起一个临时端口，打几个关键接口，断言字段在。
// 用法：npm run smoke
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as docsync from "../server/docsync.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.SMOKE_PORT || "8911";
const base = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, [join(root, "server", "server.mjs"), port], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});
let boot = "";
server.stdout.on("data", (d) => (boot += d));
server.stderr.on("data", (d) => (boot += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const r = await fetch(base + path, { headers: { "x-dash": "1" } });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
}

try {
  for (let i = 0; i < 40 && !boot.includes("http://"); i += 1) await sleep(250);

  const state = await get("/api/state");
  check("GET /api/state", !!state && !!state.now, `now=${state.now}`);
  check("state.tasks 是数组", Array.isArray(state.tasks), `${state.tasks?.length ?? "?"} 条`);
  check("state.tasks 带 docOnly 字段", (state.tasks || []).every((t) => typeof t.docOnly === "boolean"));
  check("state.tasks 带 starting / running 字段", (state.tasks || []).every((t) => "starting" in t && "running" in t));
  check("state 不再带 stage / dispatches", !("stage" in state) && !("dispatches" in state) && !("stages" in state));
  check("state.tasks[].run 不带回执全文", (state.tasks || []).every((t) => !t.run || !("result" in t.run)));
  check("state.docsync 存在", !!state.docsync, `pending=${state.docsync?.pending}`);
  check("state.docsync 带 byConnector", !!state.docsync?.byConnector && typeof state.docsync.byConnector === "object");
  check("state.connectors 存在", Array.isArray(state.connectors) && state.connectors.length > 0, `n=${state.connectors?.length}`);
  check(
    "connector 带 enabled/target/queue",
    (state.connectors || []).every((c) => typeof c.enabled === "boolean" && !!c.target && !!c.queueStats)
  );
  check("state.notify 存在", !!state.notify && typeof state.notify.enabled === "boolean", `ok=${state.notify?.ok} mode=${state.notify?.mode}`);
  check("state.terminals 存在", !!state.terminals, `count=${state.terminals?.count}`);
  check("state.history 存在", !!state.history, `runs=${state.history?.runs}`);

  const doc = await get("/api/docsync");
  check("GET /api/docsync", typeof doc.pending === "number");
  const conn = await get("/api/connectors");
  check("GET /api/connectors", Array.isArray(conn.connectors) && conn.connectors.length > 0, `n=${conn.connectors?.length}`);
  check(
    "连接器不返回密钥值",
    (conn.connectors || []).every((c) => !("token" in c) && !("secret" in c))
  );

  // 后台作业契约（拆分）：列表在、未知 id 给 404，不让前端无限转圈
  const jobList = await get("/api/jobs?kind=pool.suggest");
  check("GET /api/jobs", Array.isArray(jobList.jobs), `${jobList.jobs?.length ?? "?"} 条`);
  const noJob = await fetch(`${base}/api/job?id=nope`);
  check("GET /api/job 未知 id → 404", noJob.status === 404, `HTTP ${noJob.status}`);

  // 拆分链路（10 号方案）：SKILL 文件化 + 空子任务拒绝
  const skills = await get("/api/skills");
  const splitSkill = (skills.skills || []).find((x) => x.name === "split");
  check(
    "GET /api/skills 拆分 SKILL",
    !!splitSkill && splitSkill.output === "json-array" && (splitSkill.fields || []).includes("note"),
    (splitSkill?.fields || []).join(",")
  );
  const badSkill = await fetch(base + "/api/skills", {
    method: "POST",
    headers: { "content-type": "application/json", "x-dash": "1" },
    body: JSON.stringify({ name: "split", content: "---\noutput: json-array\nfields: [title]\n---\n缺 name 的 frontmatter" }),
  });
  check("POST /api/skills 缺 fields → 400", badSkill.status === 400, `HTTP ${badSkill.status}`);
  const badApply = await fetch(base + "/api/pool/apply", {
    method: "POST",
    headers: { "content-type": "application/json", "x-dash": "1" },
    body: JSON.stringify({ id: "nope", subs: [] }),
  });
  check("POST /api/pool/apply 空 subs → 400", badApply.status === 400, `HTTP ${badApply.status}`);

  // 回执全文单独取（列表轻量化）
  const rawTask = (state.tasks || [])[0];
  if (rawTask) {
    const run = await get(`/api/task/run?id=${encodeURIComponent(rawTask.id)}`);
    check("GET /api/task/run", !!run && "run" in run, rawTask.id);
  }

  // 6 号契约：轮 + 动作（找一个有台账会话的任务）
  const runTask = (state.tasks || []).find((t) => t.run && t.run.id);
  if (runTask) {
    const v2 = await get(`/api/task/raw?id=${encodeURIComponent(runTask.id)}&v=2`);
    check(
      "GET /api/task/raw?v=2 轮契约",
      Array.isArray(v2.rounds) && typeof v2.totalRounds === "number" && !!v2.source,
      `source=${v2.source} rounds=${v2.totalRounds}`
    );
    check(
      "GET /api/task/raw?v=2 平铺日志契约",
      Array.isArray(v2.lines) && typeof v2.lastSeq === "number" && typeof v2.hasEarlier === "boolean",
      `lines=${v2.lines?.length} first=${v2.firstSeq} last=${v2.lastSeq}`
    );
    if (Array.isArray(v2.lines) && v2.lines.length) {
      const after = await get(`/api/task/raw?id=${encodeURIComponent(runTask.id)}&v=2&after=${Number(v2.lastSeq) || 0}`);
      check(
        "GET /api/task/raw?v=2 after=lastSeq 不再重复",
        Array.isArray(after.lines) && after.lines.every((l) => Number(l.seq) > Number(v2.lastSeq)),
        `lines=${after.lines?.length}`
      );
    }
    const dl = await fetch(`${base}/api/task/stream?id=${encodeURIComponent(runTask.id)}`);
    check("GET /api/task/stream", [200, 404].includes(dl.status), `HTTP ${dl.status}`);
    try { await dl.body?.cancel(); } catch { /* ignore */ }
  } else {
    console.log("· 跳过 v=2 / stream 检查（当前没有带台账的任务）");
  }
  check("history 含 streams 计数", typeof state.history?.streams === "number", `streams=${state.history?.streams}`);

  // 终端流：一条多路复用 SSE（连上就断，不读完整流）
  const sse = await fetch(base + "/events/losflow", { headers: { "x-dash": "1" } });
  check("GET /events/losflow 是 SSE", sse.ok && (sse.headers.get("content-type") || "").includes("text/event-stream"));
  try { await sse.body?.cancel(); } catch { /* ignore */ }

  // 文档指令判定：命中追加/回填/整理 → 文档活；普通开发任务不误伤
  check("文档指令判定：追加一行", docsync.isDocSyncInstruction("在腾讯文档任务表追加一行：版本号同步"));
  check("文档指令判定：整理主表", docsync.isDocSyncInstruction("整理腾讯文档主表：把已完成的行移到归档"));
  check("文档指令判定：普通任务不误伤", !docsync.isDocSyncInstruction("Fix questionnaire skip logic"));

  // 存量 docOnly（例如历史 #5）必须挡在派单入口外；没有就不测
  const docTask = (state.tasks || []).find((t) => t.docOnly);
  if (docTask) {
    const r = await fetch(base + "/api/task/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json", "x-dash": "1" },
      body: JSON.stringify({ id: docTask.id }),
    });
    const j = await r.json().catch(() => ({}));
    check("docOnly 任务不派 Claude Code", r.status === 400, `#${docTask.id} HTTP ${r.status} ${j.error || ""}`);
  }

  const app = await fetch(base + "/app/");
  check("GET /app/（前端已构建）", app.ok, `HTTP ${app.status}`);

  const root = await fetch(base + "/", { redirect: "manual" });
  check("GET / 跳 /app/", root.status === 302 && root.headers.get("location") === "/app/", `HTTP ${root.status}`);

  const wiki = await fetch(base + "/wiki");
  check("GET /wiki", wiki.ok, `HTTP ${wiki.status}`);
} catch (err) {
  failed += 1;
  console.log("✗ 冒烟失败:", err.message);
} finally {
  server.kill();
}

console.log(failed ? `\n失败 ${failed} 项` : "\n全部通过");
process.exit(failed ? 1 : 0);
