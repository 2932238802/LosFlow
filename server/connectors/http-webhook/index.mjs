// http-webhook -- 直连型连接器：把文档动作 POST 到一个自建端点。
//
// 接 n8n / 飞书机器人 / 自建服务：LosFlow 不关心对方怎么写，只保证 body 稳定：
//   { connector, action, payload, target, at }
// token 放在 data/secrets.json（不进 config / 不返回给前端）。

export default {
  apply({ config }) {
    const target = config.target || {};
    const queue = config.queue || {};
    return {
      match() {
        return false;
      },

      describe(action, payload = {}) {
        return `HTTP webhook：${action} ${payload.subject || ""}`.trim();
      },

      async write(action, payload = {}, ctx = {}) {
        const url = String(ctx.target?.url || target.url || "").trim();
        if (!url) throw new Error("http-webhook 未配置 target.url");
        const timeoutMs = Math.max(500, Number(queue.timeoutMs) || 8000);
        const headers = { "content-type": "application/json", "user-agent": "LosFlow-connector/1.0" };
        const secret = ctx.secret;
        if (secret) headers.authorization = /^Bearer\s/i.test(secret) ? secret : `Bearer ${secret}`;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        try {
          const res = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              connector: "http-webhook",
              action,
              payload,
              target: ctx.target || target,
              at: new Date().toISOString(),
            }),
            signal: ac.signal,
          });
          const text = await res.text().catch(() => "");
          if (!res.ok) throw new Error(`HTTP ${res.status}${text ? " " + text.slice(0, 200) : ""}`);
          return { evidence: `HTTP ${res.status}${text ? " · " + text.slice(0, 200) : ""}` };
        } catch (e) {
          if (e && e.name === "AbortError") throw new Error(`请求超时（${timeoutMs}ms）`);
          throw e;
        } finally {
          clearTimeout(timer);
        }
      },
    };
  },
};
