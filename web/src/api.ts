// 统一的 HTTP 入口：写接口带 x-dash，错误体提取成一个 Error。

export async function getJSON<T = any>(path: string): Promise<T> {
  const r = await fetch(path, { cache: "no-store" });
  return r.json();
}

export async function post(path: string, body?: unknown): Promise<any> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dash": "1" },
    body: JSON.stringify(body ?? {}),
  });
  const j = await r.json().catch(() => ({ ok: false, error: "bad response" }));
  if (!r.ok || j.ok === false) throw new Error(j.error || "HTTP " + r.status);
  return j.result;
}
