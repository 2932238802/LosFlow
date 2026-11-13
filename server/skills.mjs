// skills.mjs -- 「提示词 SKILL」文件化：docs/skills/<name>.md。
//
// 为什么放在 docs/ 而不是 data/：要跟着仓库 review、能 diff、能回滚。data/ 被 git 忽略。
//
// 文件格式（frontmatter 决定契约，正文是系统提示）：
//
//   ---
//   name: split
//   output: json-array          # json-array | text
//   fields: [title, owner, reason, note]
//   ---
//   你是任务拆分助手……
//   任务：{{title}}
//   {{note}}
//   {{extra}}
//   {{schema}}
//
// 占位符：{{title}} / {{note}} / {{extra}} / {{schema}}。没写的占位符由这里自动补在末尾，
// 所以老 SKILL 不会因为少写一个占位符就丢上下文。
//
// 保存规则：frontmatter 校验失败直接 400（不落盘），旧版本备份到 .history/<name>-<时间戳>.md。
// 不引 YAML 库：frontmatter 只支持 `key: value` 与 `[a, b]`。

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

let PATHS = null;
export function initSkills(paths) {
  PATHS = paths;
}

export const SKILL_NAMES = ["split", "optimize", "optimize-dev", "optimize-docs", "optimize-plan", "split-optimize"];
// 拆分输出字段白名单（字段顺序就是 schema 顺序）
export const SPLIT_FIELDS = ["title", "owner", "reason", "note"];

const DEFAULT_SKILLS = {
  split: `---
name: split
output: json-array
fields: [title, owner, reason, note]
---
你是任务拆分助手。把一条任务拆成 3-6 条可独立执行、可独立验收的子任务。

任务：{{title}}
{{note}}
{{extra}}

硬规则：
1. 每条子任务必须自带「任务本身」（note）——看完 note 就能开工，不依赖父任务上下文。
2. 父任务说明里已经写好的要求，原样搬进对应子任务的 note，不许概括、不许省略路径、数字、行号。
3. note 写清四件事：做什么 / 照哪做 / 怎么验 / 要什么回执。
4. owner 只能是 claude-code 或 workbuddy。
5. 子任务之间不要有先后依赖，3-6 条，粒度适中。
6. note 用普通文本；必须换行时写成 \\n，不要输出未转义的引号、方括号。

输出严格 JSON 数组，不要解释、不要代码块：
{{schema}}`,

  optimize: `---
name: optimize
output: text
---
你是提示词优化助手。把用户草稿改写成一条能直接交给 Claude Code 执行的派单指令。

只输出改写后的指令，不要解释、不要客套、不要 Markdown 代码块。必须包含四要素：
1) 做什么；2) 照哪做（只给路径或文档名，不要贴全文）；3) 怎么验（具体命令）；4) 要什么回执。
保持原意、不要新增需求；信息不足时按仓库约定补全（AGENTS.md / docs/），不要反问用户。`,

  "optimize-dev": `---
name: optimize-dev
output: text
---
你是「开发」类任务的提示词优化助手。把用户草稿改写成一条能直接交给 Claude Code 执行的开发任务指令。

只输出改写后的指令，不要解释、不要客套、不要 Markdown 代码块。必须包含四要素：
1) 做什么：要改的行为 / 要修的缺陷，写清边界，不夹带无关需求；
2) 照哪做：先读哪些文档、看哪些文件（只给路径，不要贴全文）；
3) 怎么验：具体命令（构建 / 类型检查 / 单测 / 手工走查）与预期结果；
4) 要什么回执：改了哪些文件、怎么验的、未做项与风险。
保持原意、不新增需求；信息不足时按仓库约定补全（AGENTS.md / docs/），不要反问用户。`,

  "optimize-docs": `---
name: optimize-docs
output: text
---
你是「文档」类任务的提示词优化助手。把用户草稿改写成一条只动文档、不改代码的 Claude Code 指令。

只输出改写后的指令，不要解释、不要客套、不要 Markdown 代码块。必须包含四要素：
1) 做什么：要新增 / 修订哪份文档的哪一节，写清读者与目的；
2) 照哪做：先读哪些现有文档与代码来核对事实（只给路径，不要贴全文），以 docs/ 为准；
3) 怎么验：检查路径 / 链接 / 示例命令是否真实可执行，以及与其他文档是否冲突；
4) 要什么回执：改了哪些文件、依据是什么、未覆盖的点。
硬约束：不修改业务代码、不改测试、不提交；找不到依据时写明待确认，不要编造。`,

  "optimize-plan": `---
name: optimize-plan
output: text
---
你是「Plan」类任务的提示词优化助手。把用户草稿改写成一条只做分析与方案、不改代码的 Claude Code 指令。

只输出改写后的指令，不要解释、不要客套、不要 Markdown 代码块。必须包含四要素：
1) 做什么：要回答的问题 / 要产出的方案，写清范围与判定标准；
2) 照哪做：先读哪些文档、代码与历史记录（只给路径），以 docs/ 为准，不猜测；
3) 怎么验：结论要能落到文件路径:行号或可复现命令，列出证据；
4) 要什么回执：方案要点、影响面、风险与待确认项。
硬约束：全程只读，不改代码、不写数据、不提交；信息不足时列出待确认，不要反问用户。`,

  "split-optimize": `---
name: split-optimize
output: text
---
你是需求补全助手。用户给一条任务，你把它补全成「可以直接拿去拆分」的完整需求，但不要真的拆分。

要求：
1. 保持原意，不新增无关需求；信息不足时按仓库约定补全（AGENTS.md / docs/）。
2. 补全路径、文件名、验收命令、边界条件、回执要求；原文里已有的路径/数字/行号原样保留。
3. 输出一段可直接作为「任务本身」的正文，不要标题、不要解释、不要代码块。
4. 不要拆成 1./2./3. 的子任务；这是一条任务的完整描述。`,
};

const skillDir = () => join(PATHS.root, "docs", "skills");
const historyDir = () => join(skillDir(), ".history");
const skillPath = (name) => join(skillDir(), `${name}.md`);

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---- frontmatter ----
function splitFrontmatter(text) {
  const src = String(text ?? "").replace(/\r\n/g, "\n");
  if (!src.startsWith("---\n")) return { meta: null, body: src, error: "第一行必须是 ---（frontmatter 开始）" };
  const end = src.indexOf("\n---", 4);
  if (end < 0) return { meta: null, body: src, error: "找不到 frontmatter 结束的 ---" };
  const head = src.slice(4, end);
  const body = src.slice(end + 4).replace(/^\n+/, "");
  const meta = {};
  for (const rawLine of head.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) return { meta: null, body, error: `frontmatter 行无法解析：${line}` };
    const key = m[1];
    let val = m[2].trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      meta[key] = val
        .slice(1, -1)
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    } else {
      meta[key] = val;
    }
  }
  return { meta, body, error: "" };
}

export function parseSkill(name, text) {
  const { meta, body, error } = splitFrontmatter(text);
  if (error) return { error };
  if (!meta.name) return { error: "frontmatter 缺少 name" };
  if (meta.name !== name) return { error: `frontmatter 的 name 必须是 ${name}（当前 ${meta.name}）` };
  const output = meta.output || "text";
  if (output !== "text" && output !== "json-array") return { error: "output 只能是 text 或 json-array" };
  let fields = [];
  if (output === "json-array") {
    if (!Array.isArray(meta.fields) || !meta.fields.length) return { error: "json-array 必须在 fields 里声明输出字段" };
    const bad = meta.fields.filter((f) => !SPLIT_FIELDS.includes(f));
    if (bad.length) return { error: `fields 里有未支持的字段：${bad.join(", ")}（允许：${SPLIT_FIELDS.join(", ")}）` };
    if (!meta.fields.includes("title")) return { error: "fields 必须包含 title" };
    fields = meta.fields;
  }
  if (!body.trim()) return { error: "正文不能为空" };
  return { error: "", meta: { name, output, fields }, body };
}

function defaultContent(name) {
  return DEFAULT_SKILLS[name] || "";
}

// 读文件；缺文件就写内置默认（首次启动即可用）
export function loadSkill(name) {
  if (!SKILL_NAMES.includes(name)) throw new Error("未知 SKILL: " + name);
  ensureDir(skillDir());
  const file = skillPath(name);
  if (!existsSync(file)) {
    writeFileSync(file, defaultContent(name), "utf8");
  }
  const raw = readFileSync(file, "utf8");
  const parsed = parseSkill(name, raw);
  if (parsed.error) {
    // 文件被手工改坏：不阻塞主流程，退回内置默认并在返回里带上错误
    const fallback = parseSkill(name, defaultContent(name));
    return { ...fallback, name, path: file, content: raw, error: parsed.error };
  }
  return { ...parsed, name, path: file, content: raw };
}

export function saveSkill(name, content) {
  if (!SKILL_NAMES.includes(name)) throw new Error("未知 SKILL: " + name);
  const parsed = parseSkill(name, content);
  if (parsed.error) throw new Error(parsed.error);
  ensureDir(skillDir());
  ensureDir(historyDir());
  const file = skillPath(name);
  // 旧版备份（失败也不影响保存）
  try {
    if (existsSync(file)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      writeFileSync(join(historyDir(), `${name}-${stamp}.md`), readFileSync(file, "utf8"), "utf8");
    }
    // 只留最近 20 个版本
    const olds = readdirSync(historyDir()).filter((f) => f.startsWith(`${name}-`)).sort();
    for (const f of olds.slice(0, Math.max(0, olds.length - 20))) {
      try { unlinkSync(join(historyDir(), f)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  writeFileSync(file, String(content), "utf8");
  return loadSkill(name);
}

export function listSkills() {
  return SKILL_NAMES.map((name) => {
    const s = loadSkill(name);
    return {
      name,
      path: s.path,
      content: s.content,
      output: s.meta ? s.meta.output : "text",
      fields: s.meta ? s.meta.fields : [],
      error: s.error || "",
    };
  });
}

// 恢复内置默认（同样先备份旧版）
export function resetSkill(name) {
  if (!SKILL_NAMES.includes(name)) throw new Error("未知 SKILL: " + name);
  return saveSkill(name, defaultContent(name));
}

export function buildSchemaHint(fields) {
  const parts = (fields && fields.length ? fields : SPLIT_FIELDS).map((f) => `"${f}":"…"`);
  return `[{"${"title"}":"子任务标题",${parts
    .filter((p) => !p.startsWith('"title"'))
    .join(",")}}]`;
}

// 渲染一条拆分 prompt。缺占位符时自动把对应段落补在末尾。
export function renderSplitPrompt(skill, { title = "", note = "", extra = "" } = {}) {
  const fields = skill.meta && skill.meta.fields && skill.meta.fields.length ? skill.meta.fields : SPLIT_FIELDS;
  const schema = buildSchemaHint(fields);
  const blocks = {
    note: note ? `说明：\n${note}` : "",
    extra: extra ? `补充要求：\n${extra}` : "",
  };
  let body = String(skill.body || "");
  const used = new Set();
  body = body.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, key) => {
    used.add(key);
    if (key === "title") return title;
    if (key === "schema") return schema;
    if (key === "note") return blocks.note;
    if (key === "extra") return blocks.extra;
    return "";
  });
  const tail = [];
  if (!used.has("title")) tail.push(`任务：${title}`);
  if (!used.has("note") && blocks.note) tail.push(blocks.note);
  if (!used.has("extra") && blocks.extra) tail.push(blocks.extra);
  if (!used.has("schema")) tail.push("只输出严格 JSON 数组，不要解释、不要代码块：", schema);
  let out = body.trim();
  if (tail.length) out += "\n\n" + tail.join("\n");
  return out.replace(/\n{3,}/g, "\n\n");
}

// 元 Skill（text 输出）：正文即系统提示
export function renderTextSkill(skill, input) {
  const body = String(skill.body || "").trim();
  return body ? `${body}\n\n用户输入：\n${input}` : String(input || "");
}
