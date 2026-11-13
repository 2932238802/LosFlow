// 纯函数单测：node --test web/test/terminal.test.ts（Node 24 直接剥离 TS 类型）
import { test } from "node:test";
import assert from "node:assert/strict";
import { actionView, anomalies, baseName, roundMatches, summarize } from "../src/utils/terminal.ts";
import type { TermRound } from "../src/types.ts";

const act = (over: any = {}) => ({
  id: over.id || "t1",
  tool: over.tool || "Bash",
  input: over.input || {},
  ok: over.ok !== false,
  ms: over.ms ?? 12,
  out: over.out || "",
  err: over.err || null,
});

const round = (over: Partial<TermRound> = {}): TermRound => ({
  i: over.i || 1,
  msgId: over.msgId || "m1",
  at: over.at || "10:00:00",
  status: over.status || "ok",
  think: over.think || "",
  say: over.say || "",
  actions: (over.actions as any) || [],
});

test("baseName 取路径最后一段（兼容 Windows 分隔符）", () => {
  assert.equal(baseName("/home/a/b/server.mjs"), "server.mjs");
  assert.equal(baseName("C:\\x\\y\\api.md"), "api.md");
});

test("Bash 显示命令本体，不是 JSON", () => {
  const v = actionView(act({ tool: "Bash", input: { command: "npm run verify" } }));
  assert.equal(v.label, "$");
  assert.equal(v.target, "npm run verify");
  assert.equal(v.defaultOpen, true);
});

test("只看改动：读类命令不算，写类命令算", () => {
  assert.equal(actionView(act({ tool: "Bash", input: { command: "ls -la" } })).changed, false);
  assert.equal(actionView(act({ tool: "Bash", input: { command: "sed -i 's/a/b/' x.txt" } })).changed, true);
});

test("Edit 显示 +a −b", () => {
  const v = actionView(act({ tool: "Edit", input: { file_path: "/x/server.mjs", old_string: "a\nb", new_string: "a\nb\nc" } }));
  assert.equal(v.label, "改");
  assert.equal(v.target, "server.mjs");
  assert.equal(v.tail, "+3 −2");
  assert.equal(v.changed, true);
});

test("未知工具显式降级为原始名 + JSON", () => {
  const v = actionView(act({ tool: "MysteryTool", input: { foo: "bar" } }));
  assert.equal(v.label, "⚙ MysteryTool");
  assert.match(v.detail, /"foo":"bar"/);
});

test("摘要统计文件 / 动作 / 错误", () => {
  const rounds = [
    round({ actions: [act({ tool: "Edit", input: { file_path: "/x/a.ts", old_string: "1", new_string: "1\n2" } }), act({ tool: "Bash", input: { command: "ls" } })] }),
    round({ i: 2, status: "error", actions: [act({ tool: "Bash", input: { command: "npm test" }, ok: false, out: "boom" })] }),
  ];
  const s = summarize(rounds, { status: "ok", result: "", turns: 2, cost: 0.12 });
  assert.equal(s.files.length, 1);
  assert.equal(s.actions, 3);
  assert.equal(s.errors, 1);
  assert.match(s.text, /改了 1 个文件/);
  assert.match(s.text, /1 个错误/);
  assert.match(s.text, /\$0\.120/);
});

test("搜索匹配命令与输出", () => {
  const r = round({ actions: [act({ tool: "Bash", input: { command: "npm run verify" } })] });
  assert.equal(roundMatches(r, "verify"), true);
  assert.equal(roundMatches(r, "不存在的词"), false);
});

test("异常：重复命令 / 连续失败 / 长时间无输出", () => {
  const mk = (i: number, ok: boolean): TermRound =>
    round({ i, status: ok ? "ok" : "error", actions: [act({ tool: "Bash", input: { command: "npm test" }, ok })] });
  const list = [mk(1, true), mk(2, false), mk(3, false), mk(4, true)];
  const a = anomalies(list, { running: true, lastEventAt: Date.now() - 100_000, now: Date.now() });
  assert.ok(a.some((x) => x.kind === "repeat"));
  assert.ok(a.some((x) => x.kind === "fail"));
  assert.ok(a.some((x) => x.kind === "stall"));
});

test("无异常时返回空数组", () => {
  const list = [round({ actions: [act({ tool: "Bash", input: { command: "ls" } })] })];
  assert.deepEqual(anomalies(list, { running: false }), []);
});
