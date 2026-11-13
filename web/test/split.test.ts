// 纯函数单测：拆分结果的容错解析（D11）
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSplit } from "../src/utils/split.ts";

test("标准 JSON 数组", () => {
  const r = parseSplit(
    '[{"title":"A","owner":"claude-code","reason":"r","note":"正文A"},{"title":"B","owner":"workbuddy","reason":"","note":"正文B"}]'
  );
  assert.equal(r.error, "");
  assert.deepEqual(
    r.rows.map((x) => [x.title, x.owner, x.note, x.on]),
    [
      ["A", "claude-code", "正文A", true],
      ["B", "workbuddy", "正文B", true],
    ]
  );
});

test("剥掉 ```json 代码块", () => {
  const r = parseSplit('```json\n[{"title":"A","note":"n"}]\n```');
  assert.equal(r.error, "");
  assert.equal(r.rows.length, 1);
});

test("note 里有未转义换行：逐条修复后仍能解析", () => {
  const raw = '[{"title":"A","note":"第一行\n第二行"},{"title":"B","note":"ok"}]';
  const r = parseSplit(raw);
  assert.equal(r.error, "");
  assert.equal(r.rows.length, 2);
  assert.match(r.rows[0].note, /第一行[\s\S]*第二行/);
});

test("坏一条不影响其余条目，并指出第几条", () => {
  const raw = '[{"title":"A","note":"ok"},{"title":"B",note:坏},{"title":"C","note":"ok2"}]';
  const r = parseSplit(raw);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows.map((x) => x.title), ["A", "C"]);
  assert.match(r.error, /第 2 条不合法/);
});

test("note 里带方括号/花括号不会截断", () => {
  const raw = '[{"title":"A","note":"数组 [1,2] 与对象 {a:1}"}]';
  const r = parseSplit(raw);
  assert.equal(r.error, "");
  assert.equal(r.rows.length, 1);
  assert.match(r.rows[0].note, /\[1,2\]/);
});

test("没有数组时返回空且不报错", () => {
  const r = parseSplit("抱歉，我无法拆分");
  assert.deepEqual(r.rows, []);
  assert.equal(r.error, "");
});

test("缺 title 的条目被丢弃", () => {
  const r = parseSplit('[{"title":"","note":"x"},{"title":"B","note":"y"}]');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].title, "B");
});
