// wiki.mjs -- 极简 Markdown 渲染（够用就行，不引第三方库）。
// 支持：# 标题、表格、列表、代码块、行内 `code`、**粗体**、水平线、段落。

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

export function renderMarkdown(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let i = 0;
  let inCode = false;
  let codeBuf = [];

  const flushCode = () => {
    if (codeBuf.length) {
      out.push(`<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`);
      codeBuf = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith("```")) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }

    if (/^\s*$/.test(line)) { i++; continue; }

    if (/^---+\s*$/.test(line)) { out.push("<hr/>"); i++; continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    // 表格：当前行含 |，下一行是分隔行
    if (line.includes("|") && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1] || "")) {
      const header = line.split("|").map((s) => s.trim()).filter((s, idx, arr) => !(idx === 0 && s === "") && !(idx === arr.length - 1 && s === ""));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|")) {
        const cells = lines[i].split("|").map((s) => s.trim()).filter((s, idx, arr) => !(idx === 0 && s === "") && !(idx === arr.length - 1 && s === ""));
        rows.push(cells);
        i++;
      }
      out.push("<table><thead><tr>" + header.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>");
      for (const r of rows) out.push("<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>");
      out.push("</tbody></table>");
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      out.push("<ul>");
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        out.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`);
        i++;
      }
      out.push("</ul>");
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      out.push("<ol>");
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        out.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`);
        i++;
      }
      out.push("</ol>");
      continue;
    }

    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  flushCode();
  return out.join("\n");
}

export function wikiPage(title, html) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#060606;--fg:#f2f2f2;--mid:#b4b4b4;--muted:#8a8a8a;--dim:#5a5a5a;--line:#1e1e1e;
--mono:"JetBrains Mono","Cascadia Code",Consolas,monospace;
--sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:15px;line-height:1.8;font-weight:500}
.w{max-width:860px;margin:0 auto;padding:48px 32px 120px}
h1{font-family:var(--mono);font-size:20px;letter-spacing:.06em;border-bottom:1px solid var(--line);padding-bottom:14px}
h2{font-size:16px;margin-top:44px;border-top:1px solid var(--line);padding-top:22px}
h3{font-size:14px;color:var(--mid);margin-top:28px}
p,li{color:var(--mid)}
strong{color:var(--fg)}
code{font-family:var(--mono);font-size:12.5px;border:1px solid var(--line);padding:1px 6px;border-radius:2px;color:var(--fg)}
pre{background:#0b0b0b;border:1px solid var(--line);padding:16px 18px;overflow:auto;border-radius:2px}
pre code{border:0;padding:0;color:var(--mid)}
table{width:100%;border-collapse:collapse;margin:14px 0;font-size:13.5px}
th{font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}
td{padding:10px 12px;border-bottom:1px solid var(--line);color:var(--mid);vertical-align:top}
hr{border:0;border-top:1px solid var(--line);margin:28px 0}
a{color:var(--fg)}
</style></head><body><div class="w">${html}</div></body></html>`;
}
