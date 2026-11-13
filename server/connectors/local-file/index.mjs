// local-file -- 本地 Markdown 台账连接器（直连型）。
//
// 不依赖 WorkBuddy：推入/标记完成时直接在 data/ledger/<project>.md 里追加/改一行。
// 适合断网、WorkBuddy 未启动时的兜底留痕；内容是可读的 Markdown 表格。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const HEADER = "| 任务 | 优先级 | 状态 | 备注 | 更新时间 |\n| --- | --- | --- | --- | --- |\n";

function clean(v) {
  return String(v ?? "").replace(/\|/g, "／").replace(/\r?\n/g, " ").trim();
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function safeName(s) {
  const raw = String(s || "default").replace(/[\\/]+$/, "");
  const base = raw.split(/[\\/]/).filter(Boolean).pop() || "default";
  const t = base.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/^\.+/, "");
  return t || "default";
}
function row(subject, priority, status, note) {
  return `| ${clean(subject)} | ${clean(priority)} | ${clean(status)} | ${clean(note)} | ${stamp()} |`;
}

export default {
  apply({ config, paths }) {
    const target = config.target || {};
    return {
      match() {
        return false;
      },

      describe(action, payload = {}) {
        return `本地台账：${action} ${payload.subject || ""}`.trim();
      },

      async write(action, payload = {}, ctx = {}) {
        if (action === "cleanup") return { evidence: "local-file: cleanup 无需执行" };
        let base;
        const rawDir = String(target.dir || "").trim();
        if (rawDir && isAbsolute(rawDir)) base = rawDir;
        else if (/^data[\\/]/i.test(rawDir)) base = join(paths.dataDir, rawDir.replace(/^data[\\/]/i, ""));
        else if (rawDir) base = join(paths.root, rawDir);
        else base = paths.ledgerDir;
        const project = safeName(payload.project || "default");
        const file = join(base, `${project}.md`);
        if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
        let text = existsSync(file) ? readFileSync(file, "utf8") : `# ${project} 台账\n\n${HEADER}`;
        if (!text.includes("| 任务 |")) text += `\n${HEADER}`;
        const subject = clean(payload.subject || "（无标题）");
        const lines = text.split("\n");
        const idx = lines.findIndex((l) => l.startsWith(`| ${subject} |`));
        const nextRow = row(payload.subject, payload.priority || "", payload.status || "", payload.note || "");
        if (action === "update-row" && idx >= 0) {
          lines[idx] = nextRow;
          text = lines.join("\n");
        } else if (action === "probe") {
          text = text.replace(/\s*$/, "\n") + row(`LosFlow 连接器测试 ${stamp()}`, "", "测试", "local-file probe") + "\n";
        } else {
          text = text.replace(/\s*$/, "\n") + nextRow + "\n";
        }
        const tmp = `${file}.tmp.${process.pid}`;
        writeFileSync(tmp, text, "utf8");
        try {
          renameSync(tmp, file);
        } catch {
          writeFileSync(file, text, "utf8");
        }
        return { evidence: `${action} → ${file}` };
      },
    };
  },
};
