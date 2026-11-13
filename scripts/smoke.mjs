// smoke.mjs -- 冒烟：起一个临时端口，打几个关键接口，断言字段在。
// 用法：npm run smoke
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  check("GET /api/state", !!state && typeof state.stage !== "undefined", `stage=${state.stage}`);
  check("state.tasks 是数组", Array.isArray(state.tasks), `${state.tasks?.length ?? "?"} 条`);
  check("state.docsync 存在", !!state.docsync, `pending=${state.docsync?.pending}`);
  check("state.terminals 存在", !!state.terminals, `count=${state.terminals?.count}`);
  check("state.history 存在", !!state.history, `runs=${state.history?.runs}`);

  const doc = await get("/api/docsync");
  check("GET /api/docsync", typeof doc.pending === "number");

  const app = await fetch(base + "/app/");
  check("GET /app/（前端已构建）", app.ok, `HTTP ${app.status}`);

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
