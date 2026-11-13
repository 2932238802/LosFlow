// tencent-wb -- 腾讯文档任务表的执行型连接器。
//
// 它自己不写表：把「要写什么」翻译成一段人话指令，交给 WorkBuddy 的
// next_docsync 取走执行；写完用 report_docsync 回执。默认行为与 13 号文档
// 之前完全一致，只是 URL / tab / 列名来自配置。
//
// 唯一的代码职责：match（判定这是不是文档活）与 describe（生成指令）。

function regexes(patterns) {
  const out = [];
  for (const p of patterns || []) {
    try {
      out.push(new RegExp(p, "i"));
    } catch {
      /* 配置里的坏正则不影响其它规则 */
    }
  }
  return out;
}

export default {
  apply({ config }) {
    const target = config.target || {};
    const mapping = config.mapping || {};
    const rules = config.match || {};
    const urlRe = regexes(rules.urlPatterns || []);
    const keyRe = regexes(rules.keywords || []);
    const actionRe = /(追加|新增|写入|补写|整理|归档|移(?:到|入|出|至))/;
    const titleCol = mapping.title || "任务";
    const statusCol = mapping.status || "任务状态";
    const noteCol = mapping.note || "备注";
    const priorityCol = mapping.priority || "优先级";

    return {
      match(text) {
        const s = String(text || "");
        if (!s) return false;
        if (keyRe.some((re) => re.test(s))) return true;
        return urlRe.some((re) => re.test(s)) && actionRe.test(s);
      },

      describe(action, payload = {}) {
        const p = payload || {};
        const base = [
          `表格：${target.url || "（未配置）"}`,
          target.tab ? `主表 tab：${target.tab}` : "",
        ].filter(Boolean);

        if (action === "cleanup") {
          return [
            `文档 ${target.url || "（未配置）"} 的主表${target.tab ? `（tab ${target.tab}）` : ""}。`,
            `任务：整理主表 —— 把【${statusCol}】为「已完成」或「已搁置」的数据行，从主表移除，按完成日期追加到「${target.archiveTab || "归档"}」tab。`,
            "硬约束：",
            `1) 只动数据行，不动表头、序号公式、格式、筛选、隐藏列；`,
            `2) 目标 tab 是「${target.archiveTab || "归档"}」（没有就先建，并把表头复制过去）；`,
            "3) 逐行移动，移完读回核对：主表剩余行数、归档新增行数；",
            "4) 用 report_task 回填：移了几行、主表剩几行、归档现有几行、读回校验结果。",
            p.note ? `补充：${p.note}` : "",
            "做不到就回填 blocked，写清卡在哪一步 + 报错原文。",
          ]
            .filter(Boolean)
            .join("\n");
        }

        if (action === "probe") {
          return [
            "连接器测试：在下方表格末尾追加一行测试数据，写完读回确认。",
            ...base,
            `任务：${p.subject || "LosFlow 连接器测试"}`,
            `状态：${p.status || "测试"}`,
            "写完用 report_docsync 回执：{id, status: \"done\", evidence: 行号+读回校验}",
          ].join("\n");
        }

        if (action === "update-row") {
          return [
            ...base,
            `动作：update-row —— 在主表「${titleCol}」列找到名称等于下面任务的那一行（有多行取最后一行），只改【${statusCol}】和【${noteCol}】两列；找不到这一行就按 append-row 追加一行。不要动其他行、列、公式、格式`,
            `任务：${p.subject || ""}`,
            `${statusCol}：${p.status || ""}`,
            p.priority ? `${priorityCol}：${p.priority}` : "",
            p.note ? `${noteCol}：${p.note}` : "",
            "写完用 report_docsync 回执：{id, status: \"done\", evidence: 行号+读回校验}",
            "做不到就回填 failed，写清卡在哪一步 + 报错原文（会自动重试）。",
          ]
            .filter(Boolean)
            .join("\n");
        }

        return [
          ...base,
          `动作：append-row —— 在主表末尾追加一行${mapping.serialFormula === false ? "" : "；序号列不手写（沿用已有公式）"}`,
          `任务：${p.subject || ""}`,
          `${statusCol}：${p.status || ""}`,
          p.priority ? `${priorityCol}：${p.priority}` : "",
          p.note ? `${noteCol}：${p.note}` : "",
          "写完用 report_docsync 回执：{id, status: \"done\", evidence: 行号+读回校验}",
          "做不到就回填 failed，写清卡在哪一步 + 报错原文（会自动重试）。",
        ]
          .filter(Boolean)
          .join("\n");
      },
    };
  },
};
