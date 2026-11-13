<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

type PoolItem = { id: string; title: string; note: string; kind?: string; stage: string; children: string[]; pushTaskId: string | null; priority?: string };
type Task = {
  id: string; subject: string; owner: string; status: string; evidence: string;
  note?: string; repo?: string; kind?: string; type?: string; updatedAt?: number; sessionId?: string;
  wb?: { takenAt?: string; reportedAt?: string; reportStatus?: string } | null;
  run?: { id?: string; at?: string; status?: string; cost?: number } | null;
};
type Approval = { id: string; commands: string[]; suggested: string[]; dispatch: string; status: string };
type State = {
  progress: { status: string; updated: string; blocked: string };
  projects: { id: string; name: string; path: string }[];
  maintenance?: { count?: number; threshold?: number; lastAt?: string };
  pool: PoolItem[]; approvals: Approval[]; tasks: Task[]; spendToday: number;
  running?: { id: string; taskId?: string; startedAt?: string; task?: string } | null;
};
type RawLine = { kind: string; text: string };

type View = "tasks" | "terminals" | "done" | "wb" | "docs" | "settings";
const VIEWS: View[] = ["tasks", "terminals", "done", "wb", "docs", "settings"];
const VIEW_KEY = "losflow.view";
function loadView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY) as View | null;
    if (v && VIEWS.includes(v)) return v;
  } catch { /* 隐私模式之类，忽略 */ }
  return "tasks";
}
const s = ref<State | null>(null);
const view = ref<View>(loadView());
// 刷新/重开保持上次停留的页面，不默认跳回「任务」
watch(view, (v) => {
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ }
});
const open = ref<string | null>(null);
const raws = ref<Record<string, RawLine[]>>({});
const wb = ref<any[]>([]);
const wbOpen = ref(false);
const msg = ref(""); const err = ref(false); const busy = ref("");
const editing = ref<string | null>(null); const subs = ref("");
const pushing = ref<string | null>(null); const prio = ref("中");
const newTitle = ref(""); const newBody = ref("");
const newProject = ref("");

const splitItem = ref<PoolItem | null>(null);
const splitPrompt = ref("");
const splitList = ref<{ title: string; owner: string; reason: string; on: boolean }[]>([]);
const splitBusy = ref(false);
const tplOpen = ref(false);
const tpl = ref({ splitSystem: "", optimizeSystem: "" });
const projOpen = ref(false);
const projName = ref("");
const projPath = ref("~");
const projDirs = ref<string[]>([]);
const projParent = ref("");
const projErr = ref("");
const projPickOpen = ref(false);
const threshold = ref(5);
const cronPrompt = ref("");
const pointOpen = ref<string>("");
const termOpen = ref<Record<string, boolean>>({});  // 默认全部收起，点哪条开哪条
function toggleTerm(id: string) { termOpen.value = { ...termOpen.value, [id]: !termOpen.value[id] }; }

// 终端滚动：默认停在顶部，右下角给一个「↓ 底部」按钮，点了才下去
const termEls: Record<string, HTMLElement | null> = {};
const termAtBottom = ref<Record<string, boolean>>({});
function isAtBottom(id: string) { return termAtBottom.value[id] === true; }
function updateBottom(id: string) {
  const el = termEls[id];
  if (!el) return;
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  if (near !== isAtBottom(id)) termAtBottom.value = { ...termAtBottom.value, [id]: near };
}
function scrollBottom(id: string) {
  nextTick(() => {
    const el = termEls[id];
    if (el) el.scrollTop = el.scrollHeight;
    updateBottom(id);
  });
}
function onTermScroll(id: string) {
  updateBottom(id);
}
function setTermEl(id: string, el: unknown) {
  termEls[id] = (el as HTMLElement) || null;
  if (termEls[id]) nextTick(() => updateBottom(id));
}
watch(
  () => view.value,
  (v) => {
    if (v === "terminals") for (const x of termTasks.value) loadRaw(x.id);
  }
);
watch(
  () => Object.keys(raws.value).map((k) => `${k}:${(raws.value[k] || []).length}`).join(","),
  () => {
    // 内容变长后重新判断「是否已在底部」，但不自动滚动
    for (const id of Object.keys(raws.value)) nextTick(() => updateBottom(id));
  }
);
const sheet = ref<{ title: string; body: string; json?: any } | null>(null);
const nowMs = ref(Date.now());
const drafts = reactive<Record<string, string>>({});
const optInfo = ref<Record<string, any>>({});
const runInfo = ref<Record<string, any>>({});

function draftOf(t: Task) {
  if (drafts[t.id] === undefined) drafts[t.id] = t.note || t.subject;
  return drafts[t.id];
}
function flash(t: string, isErr = false) {
  msg.value = t; err.value = isErr;
  clearTimeout((flash as any)._t);
  (flash as any)._t = setTimeout(() => (msg.value = ""), isErr ? 7000 : 3200);
}
async function post(path: string, body?: unknown) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-dash": "1" }, body: JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => ({ ok: false, error: "bad response" }));
  if (!r.ok || j.ok === false) throw new Error(j.error || "HTTP " + r.status);
  return j.result;
}
async function refresh() {
  try { s.value = await (await fetch("/api/state", { cache: "no-store" })).json(); } catch { /* offline */ }
}
async function loadRaw(id: string) {
  try {
    const j = await (await fetch(`/api/task/raw?id=${encodeURIComponent(id)}`, { cache: "no-store" })).json();
    raws.value = { ...raws.value, [id]: j.lines || [] };
    runInfo.value = { ...runInfo.value, [id]: j.dispatch ? { id: j.dispatch, running: j.running } : null };
  } catch { /* ignore */ }
}
function toggleOpen(id: string) { open.value = open.value === id ? null : id; }

const currentProjectName = computed(() => {
  const list = s.value?.projects || [];
  const hit = list.find((x) => x.path === newProject.value);
  return hit ? hit.name : "选项目";
});

const pct = (t: Task) => {
  if (t.status === "done") return 100;
  if (t.status === "doing") return 55;
  if (t.status === "blocked") return 30;
  // todo：先算「已落库」，异步文档同步回执后再推进一格（台账就绪，等开工）
  const d = (t as any).docSync as { status?: string } | null;
  return d && d.status === "done" ? 30 : 10;
};
const openTasks = computed(() => (s.value?.tasks || []).filter((t) => t.status !== "done"));
const doneTasks = computed(() => (s.value?.tasks || []).filter((t) => t.status === "done"));
const poolOpen = computed(() => (s.value?.pool || []).filter((p) => p.stage !== "pushed"));
const poolDone = computed(() => (s.value?.pool || []).filter((p) => p.stage === "pushed"));
const pending = computed(() => (s.value?.approvals || []).filter((a) => a.status === "pending"));
const runningId = computed(() => (s.value?.running && s.value.running.taskId) || null);
const runningElapsed = computed(() => {
  const st = s.value?.running?.startedAt;
  if (!st) return 0;
  const t0 = new Date(st.replace(" ", "T")).getTime();
  return Math.max(0, Math.round((nowMs.value - t0) / 1000));
});
function isRunning(id: string) { return runningId.value === String(id); }
const fullTerm = ref<string | null>(null);
function goTerm(id: string) {
  view.value = "terminals";
  termOpen.value = { ...termOpen.value, [id]: true };
  loadRaw(id);
}
async function delRun(t: Task) {
  const runId = t.run?.id;
  if (!runId) { flash("这条没有可删的派单记录", true); return; }
  const ok = window.confirm(
    `删除 #${t.id} 的这次会话（${runId}）？\n\n会一起删：\n· WSL /tmp 里的脚本/日志/流\n· tools/runs 归档\n· 台账里这一行\n· 任务上的会话指针（之后再跑是「新会话」）\n\n台账这行删掉后，今天的花费统计也会少这一笔。`
  );
  if (!ok) return;
  try {
    const r = await post("/api/run/delete", { id: runId, taskId: t.id });
    flash(`已删：WSL ${r.wslFiles} 个文件 · 归档 ${r.removedRun ? 1 : 0} · 台账 ${r.ledgerRemoved} 行 · 清掉 ${r.clearedTasks} 条会话指针`);
    // 立刻从终端列表里拿掉（任务本身不删），不等下一次轮询
    termGone.value = { ...termGone.value, [t.id]: true };
    delete raws.value[t.id];
    setTimeout(refresh, 300);
  } catch (e: any) { flash(e.message, true); }
}
async function copyTerm(id: string) {  const text = (raws.value[id] || []).map((l) => l.text).join("\n");
  try { await navigator.clipboard.writeText(text); flash(`已复制 #${id} 的 ${(raws.value[id] || []).length} 行`); }
  catch { flash("复制失败（浏览器不给剪贴板权限）", true); }
}
const termCount = computed(() => Number((s.value as any)?.terminals?.count || 0));
const termRuns = computed(() => ((s.value as any)?.terminals?.items || []) as Array<{ id: string; pid: number; startedAt: string }>);
const termGone = ref<Record<string, boolean>>({});
const termTasks = computed(() => {
  // 正在跑的任务也要进来：它要等跑完才有 sessionId
  const list = (s.value?.tasks || []).filter((x) => (x.sessionId || isRunning(x.id) || x.run) && !termGone.value[x.id]);
  list.sort((a, b) => (isRunning(b.id) ? 1 : 0) - (isRunning(a.id) ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
  return list.slice(0, 8);
});
// 同一个任务重新开工时，把「已从终端删掉」的标记撤掉
watch(runningId, (id) => {
  if (id && termGone.value[id]) {
    const m = { ...termGone.value };
    delete m[id];
    termGone.value = m;
  }
});

function stageInfo(t: Task) {
  if (t.owner === "workbuddy") {
    if (t.wb?.reportedAt) return { text: `已回填 ${t.wb.reportStatus || ""} ${t.wb.reportedAt.slice(11, 16)}`, tone: "done" };
    if (t.wb?.takenAt) return { text: `WB 已取走 ${t.wb.takenAt.slice(11, 16)}`, tone: "live" };
    return { text: t.nudgedAt ? `等待 WB 取走 · 已催 ${t.nudges || 1} 次` : "等待 WB 取走", tone: "wait" };
  }
  if (isRunning(t.id)) return { text: "Claude 执行中", tone: "live" };
  if (t.status === "done") return { text: "已完成", tone: "done" };
  return { text: "待派单", tone: "wait" };
}
function docText(t: Task) {
  const d = (t as any).docSync as { status?: string; attempts?: number; doneAt?: number } | null;
  if (!d || !d.status) return "";
  if (d.status === "done") {
    const hhmm = d.doneAt ? new Date(d.doneAt).toTimeString().slice(0, 5) : "";
    return `文档已同步${hhmm ? " " + hhmm : ""}`;
  }
  const map: Record<string, string> = {
    pending: "文档同步排队中",
    running: "文档同步写入中",
    failed: `文档同步失败（试 ${d.attempts || 0} 次）`,
  };
  return map[d.status] || "";
}
function fmtBytes(n: number) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = Number(n) || 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
async function purge(hours: number) {
  busy.value = "purge";
  try {
    const r = await post("/api/maintenance/purge", { hours });
    flash(`已清 ${r.runs} 个 run、${r.wsl} 个 WSL 临时文件，剩 ${r.left.runs} 个`);
    refresh();
  } catch (e: any) { flash(e.message, true); }
  busy.value = "";
}
function cmdText(a: any) {
  const list = Array.isArray(a?.commands)
    ? a.commands
    : String(a?.cmd || "")
        .split("\n")
        .filter(Boolean);
  return list.join("  |  ") || "（没有命令原文）";
}
function waitedFor(t: Task) {
  if (!t.updatedAt) return 0;
  return Math.max(0, Math.round((nowMs.value - t.updatedAt) / 60000));
}

async function optimizeDraft() {
  const text = newBody.value.trim() || newTitle.value.trim();
  if (!text) return flash("先写点内容再优化", true);
  busy.value = "draft";
  flash("优化中…");
  try {
    const r = await post("/api/prompt/optimize", { text });
    newBody.value = r.prompt || text;
    flash("已优化，检查后加入池");
  } catch (e: any) { flash(e.message, true); }
  busy.value = "";
}
async function saveThreshold() {
  try {
    const r = await post("/api/maintenance/config", { threshold: Number(threshold.value) || 0 });
    flash(Number(threshold.value) > 0 ? `每 ${threshold.value} 条自动整理` : "已关闭自动整理");
    refresh();
  } catch (e: any) { flash(e.message, true); }
}
function buildCronPrompt() {
  cronPrompt.value = [
    "【每天的整理动作】",
    "1) 打开腾讯文档任务表：https://docs.qq.com/sheet/DZVFSeURwdmVJdVZL?tab=BB08J2",
    "2) 主表里任务状态为「已完成」或「已搁置」的行，移到「归档」tab（没有就建，并复制表头）",
    "3) 只动数据行，不动表头、序号公式、格式、筛选、隐藏列",
    "4) 移完读回核对：主表剩几行、归档有几行，用 report_task 回填结果",
    "5) 如果主表没有已完成的行，直接结束，不要建新行",
  ].join("\n");
}
function pickProject(path: string) {
  newProject.value = path;
  projPickOpen.value = false;
}
async function openProj() {
  projOpen.value = true;
  projName.value = "";
  projErr.value = "";
  await browse("~");
}
async function browse(path: string) {
  try {
    const j = await (await fetch(`/api/wsl/ls?path=${encodeURIComponent(path)}`, { cache: "no-store" })).json();
    if (j.error) projErr.value = j.error;
    projPath.value = j.path || path;
    projParent.value = j.parent || "";
    projDirs.value = j.dirs || [];
  } catch (e: any) { projErr.value = e.message; }
}
async function saveProj() {
  const name = projName.value.trim();
  if (!name) return flash("给项目起个名字", true);
  try {
    await post("/api/projects/add", { name, path: projPath.value });
    projOpen.value = false;
    newProject.value = projPath.value;
    flash(`已添加项目 ${name}`);
    refresh();
  } catch (e: any) { flash(e.message, true); }
}
async function delProj(id: string) {
  try { await post("/api/projects/remove", { id }); refresh(); } catch (e: any) { flash(e.message, true); }
}
async function add() {
  const t = newTitle.value.trim();
  if (!t) return;
  try { await post("/api/pool/add", { title: t, note: newBody.value, project: newProject.value }); newTitle.value = ""; newBody.value = ""; flash("已加入任务池"); refresh(); }
  catch (e: any) { flash(e.message, true); }
}
async function removePool(it: PoolItem) {
  try {
    await post("/api/pool/remove", { id: it.id });
    newTitle.value = it.title || "";
    
    if (it.project) newProject.value = it.project;
    await refresh();
    focusNew();
    flash("已删除，文字放回新建框");
  } catch (e: any) { flash(e.message, true); }
}
async function doPush() {
  const id = pushing.value!;
  busy.value = "push";
  try {
    const r = await post("/api/pool/push", { id, priority: prio.value });
    pushing.value = null;
    const n = (r.created || []).length;
    const docN = (r.docsync || []).length;
    const auto = r.autoStarted || [];
    flash(
      `已推入 ${n} 条${docN ? ` · 文档同步排队 ${docN} 条` : ""}` +
        (auto.length ? ` · 已自动开工 ${auto.map((x: string) => "#" + x).join(" ")}` : " · 点「执行」即可开工")
    );
    refresh();
  } catch (e: any) { flash(e.message, true); }
  busy.value = "";
}
function openSplit(it: PoolItem) {
  splitItem.value = it;
  splitPrompt.value = it.note || "";
  splitList.value = [];
}
async function aiSplit() {
  const it = splitItem.value;
  if (!it) return;
  splitBusy.value = true;
  flash("让 Claude Code 拆…（约 15 秒，限 $0.35）");
  try {
    const r = await post("/api/pool/suggest", { id: it.id, prompt: splitPrompt.value });
    const m = (r.raw || "").match(/\[[\s\S]*\]/);
    const arr = m ? JSON.parse(m[0]) : [];
    splitList.value = arr.map((x: any) => ({
      title: String(x.title || ""),
      owner: x.owner === "workbuddy" ? "workbuddy" : "claude-code",
      reason: String(x.reason || ""),
      on: true,
    }));
    if (!splitList.value.length) flash("没解析出子任务，换句话再试", true);
  } catch (e: any) { flash(e.message, true); }
  splitBusy.value = false;
}
async function applySplit() {
  const it = splitItem.value;
  if (!it) return;
  const picked = splitList.value.filter((x) => x.on && x.title.trim());
  if (!picked.length) return flash("至少选一条", true);
  splitBusy.value = true;
  try {
    const r = await post("/api/pool/apply", { id: it.id, subs: picked });
    flash(`已加入池子 ${r.created.length} 条`);
    splitItem.value = null;
    refresh();
  } catch (e: any) { flash(e.message, true); }
  splitBusy.value = false;
}
function addManualLine() {
  splitList.value = [...splitList.value, { title: "", owner: "claude-code", reason: "", on: true }];
}
async function optimizeSplitPrompt() {
  const text = splitPrompt.value.trim();
  if (!text) return flash("先写点需求", true);
  splitBusy.value = true;
  try {
    const r = await post("/api/prompt/optimize", { text });
    splitPrompt.value = r.prompt || text;
    flash("已优化拆分提示词");
  } catch (e: any) { flash(e.message, true); }
  splitBusy.value = false;
}
async function openTpl() {
  try {
    const r = await post("/api/templates", {});
    tpl.value = r.templates;
    tplOpen.value = true;
  } catch (e: any) { flash(e.message, true); }
}
async function saveTpl() {
  try {
    await post("/api/templates", tpl.value);
    tplOpen.value = false;
    flash("模板已保存");
  } catch (e: any) { flash(e.message, true); }
}
async function dispatchTask(t: Task, cont = false) {
  busy.value = t.id; flash(cont ? "续接…" : "派给 Claude Code…");
  try {
    const r = await post(cont ? "/api/task/continue" : "/api/task/dispatch", { id: t.id, task: drafts[t.id] || t.note || t.subject });
    flash(`${cont ? "续接" : "派单"} ${r.dispatch?.status || "?"}`);
    await loadRaw(t.id);
  } catch (e: any) { flash(e.message, true); }
  busy.value = ""; refresh();
}
async function stopRun() { busy.value = "stop"; try { const r = await post("/api/run/stop"); flash(r.note || "已终止"); } catch (e: any) { flash(e.message, true); } busy.value = ""; refresh(); }
async function delTask(t: Task) {
  try {
    await post("/api/task/delete", { id: t.id });
    newTitle.value = t.subject || "";
    
    if (t.repo) newProject.value = t.repo;
    view.value = "tasks";
    await refresh();
    focusNew();
    flash("已删除，文字放回新建框");
  } catch (e: any) { flash(e.message, true); }
}
function focusNew() {
  setTimeout(() => {
    const el = document.getElementById("newTitleInput") as HTMLInputElement | null;
    el?.focus();
    el?.select();
  }, 30);
}
async function setRepo(t: Task) {
  const r = window.prompt("Claude Code 工作目录（WSL 路径）", t.repo || "~/LosAngelous/Vesta");
  if (r === null) return;
  try { await post("/api/task/repo", { id: t.id, repo: r.trim() }); refresh(); } catch (e: any) { flash(e.message, true); }
}
async function optimizePrompt(t: Task) {
  busy.value = t.id;
  const text = (drafts[t.id] ?? "").trim();
  if (!text) { busy.value = ""; return flash("先写点东西再优化", true); }
  flash("优化中…");
  try {
    const r = await post("/api/prompt/optimize", { text, taskId: t.id });
    drafts[t.id] = r.prompt || text;
    optInfo.value = { ...optInfo.value, [t.id]: { cost: r.cost, at: new Date().toTimeString().slice(0, 5) } };
    flash("已优化，确认后再推送");
  } catch (e: any) { flash(e.message, true); }
  busy.value = ""; refresh();
}
async function genDocs(t: Task) {
  busy.value = t.id; flash("生成需求/交付/验收…");
  try {
    const r = await post("/api/task/docs", { id: t.id, title: t.subject, note: t.note || "" });
    const m = (r.raw || "").match(/\{[\s\S]*\}/);
    sheet.value = { title: `${t.subject} · 需求文档`, body: r.raw || "", json: m ? JSON.parse(m[0]) : null };
  } catch (e: any) { flash(e.message, true); }
  busy.value = ""; refresh();
}
async function splitTask(t: Task) {
  busy.value = t.id; flash("智能拆分…");
  try {
    const r = await post("/api/task/split", { id: t.id, title: t.subject, note: t.note || "" });
    const m = (r.raw || "").match(/\[[\s\S]*\]/);
    sheet.value = { title: `${t.subject} · 拆分建议`, body: r.raw || "", json: m ? JSON.parse(m[0]) : null };
  } catch (e: any) { flash(e.message, true); }
  busy.value = ""; refresh();
}
async function nudge(t: Task) {
  try {
    const r = await post("/api/task/nudge", { id: t.id });
    sheet.value = { title: `催促 WorkBuddy · #${t.id}`, body: r.text };
    flash(`已生成催促文案（第 ${r.nudges} 次）`);
    refresh();
  } catch (e: any) { flash(e.message, true); }
}
async function copySheet() {
  try {
    await navigator.clipboard.writeText(sheet.value?.body || "");
    flash("已复制，去 WorkBuddy 粘贴");
  } catch { flash("复制失败，手动选中吧", true); }
}
async function cleanup() {
  try {
    const r = await post("/api/maintenance/cleanup", {});
    flash(`已建整理任务 #${r.task.id}，等 WorkBuddy 取走`);
    refresh();
  } catch (e: any) { flash(e.message, true); }
}
async function approve(id: string) { try { await post("/api/approve", { id }); flash("已批准"); refresh(); } catch (e: any) { flash(e.message, true); } }
async function reject(id: string) { try { await post("/api/reject", { id }); flash("已拒绝"); refresh(); } catch (e: any) { flash(e.message, true); } }

let timer = 0; let logTimer = 0; let es: EventSource | null = null;
onMounted(() => {
  refresh();
  if (!location.search.includes("static")) {
    es = new EventSource("/events/workbuddy");
    es.onmessage = (m) => { const e = JSON.parse(m.data); wb.value = [...wb.value, e].slice(-40); };
  }
  timer = window.setInterval(refresh, 5000);
  window.setInterval(() => (nowMs.value = Date.now()), 1000);
  logTimer = window.setInterval(() => {
    if (view.value === "terminals") for (const x of termTasks.value) loadRaw(x.id);
    else if (isRunning(String(runningId.value))) loadRaw(String(runningId.value));
  }, 2000);
});
onBeforeUnmount(() => { clearInterval(timer); clearInterval(logTimer); es?.close(); });
</script>

<template>
  <div class="shell">
    <aside class="side">
      <div class="brand">LOSFLOW</div>
      <nav class="nav">
        <button :class="{ on: view === 'tasks' }" @click="view = 'tasks'">任务 <b>{{ openTasks.length + poolOpen.length }}</b></button>
        <button :class="{ on: view === 'terminals' }" @click="view = 'terminals'">终端 <b :class="{ live: termCount > 0 }">{{ termCount }}</b></button>
        <button :class="{ on: view === 'done' }" @click="view = 'done'">已完成 <b>{{ doneTasks.length }}</b></button>
        <button :class="{ on: view === 'wb' }" @click="view = 'wb'">WorkBuddy <b>{{ wb.length || "" }}</b></button>
        <button :class="{ on: view === 'docs' }" @click="view = 'docs'">文档</button>
        <button :class="{ on: view === 'settings' }" @click="view = 'settings'">设置</button>
      </nav>
      <div class="side-foot">
        <div v-if="runningId" class="live-line"><span class="mini-dot on"></span> CC 执行中 {{ runningElapsed }}s</div>
        <div class="cost">${{ Number(s?.spendToday || 0).toFixed(3) }}</div>
      </div>
    </aside>

    <main class="main" :class="{ wide: view === 'terminals' }">
      <div class="msg" :class="{ err }">{{ msg }}</div>

      <!-- 任务 -->
      <template v-if="view === 'tasks'">
        <section>
          <div class="hd">
            已推入 <b>{{ openTasks.filter((x) => x.status !== 'done').length }}</b>
            <span class="sp"></span>
            <button class="act" @click="cleanup">整理主表</button>
          </div>
          <div v-if="!openTasks.length" class="empty">— 没有进行中的任务 —</div>
          <div v-for="t in openTasks" :key="t.id" class="card" :class="{ running: isRunning(t.id) }">
            <div class="row" @click="toggleOpen(t.id)">
              <span class="caret" :class="{ on: open === t.id }">›</span>
              <span class="title">#{{ t.id }} {{ t.subject }}</span>
              <span class="badge">{{ t.owner === "workbuddy" ? "WB" : "CC" }}</span>
              <span class="sp"></span>
              <span v-if="isRunning(t.id)" class="badge live">{{ runningElapsed }}s</span>
            </div>
            <div class="pbar"><div class="fill" :style="{ width: pct(t) + '%' }"></div></div>
            <div class="stage-line">
              <span class="stage-badge" :class="stageInfo(t).tone">{{ stageInfo(t).text }}</span>
              <span v-if="waitedFor(t) > 0" class="pmeta">已等 {{ waitedFor(t) }} 分钟</span>
              <span v-if="docText(t)" class="pmeta">{{ docText(t) }}</span>
              <a v-if="t.run || t.sessionId || isRunning(t.id)" class="lnk" @click.stop="goTerm(t.id)">终端 ›</a>
            </div>

            <div v-if="open === t.id" class="detail">
              <div class="pmeta" style="margin-bottom:10px">
                {{ t.repo || "~/LosAngelous/Vesta" }}
                <span v-if="t.sessionId"> · 会话 {{ t.sessionId.slice(0, 8) }}</span>
                <span v-else> · 尚未开会话</span>
                <a class="lnk" @click="setRepo(t)">改目录</a>
              </div>
              <!-- Claude Code 任务：提示词发给 CC -->
              <div v-if="t.owner !== 'workbuddy'" class="promptbox">
                <div class="hint">提示词 · 发给 <b>Claude Code</b></div>
                <textarea :value="draftOf(t)" rows="3" @input="drafts[t.id] = ($event.target as HTMLTextAreaElement).value"></textarea>
                <div class="acts">
                  <button class="act" :disabled="busy === t.id" @click="optimizePrompt(t)">优化提示词</button>
                  <button class="act" :disabled="busy === t.id" @click="dispatchTask(t)">{{ t.sessionId ? "发给 Claude Code（续接）" : "发给 Claude Code（新会话）" }}</button>
                  <span v-if="optInfo[t.id]" class="pmeta">已优化 {{ optInfo[t.id].at }} · ${{ Number(optInfo[t.id].cost || 0).toFixed(3) }}</span>
                </div>
              </div>

              <!-- WorkBuddy 任务：执行说明只读 -->
              <div v-else class="promptbox">
                <div class="hint">执行说明 · 发给 <b>WorkBuddy</b>（只读）</div>
                <pre class="note-pre">{{ t.note || t.subject }}</pre>
              </div>
              <div class="acts">
                <button v-if="t.kind === 'company'" class="act" :disabled="busy === t.id" @click="genDocs(t)">需求/交付/验收</button>
                <button v-if="t.sessionId || isRunning(t.id) || t.run" class="act" @click="goTerm(t.id)">看终端</button>
                <button
                  v-if="t.owner === 'workbuddy' && !t.wb?.takenAt"
                  class="act" @click="nudge(t)">催促 WB</button>
                <span class="sp"></span>
                <button class="act danger" @click="stopRun">终止</button>
                <button class="act danger" @click="delTask(t)">删除</button>
              </div>
            </div>
          </div>
        </section>

        <section>
          <div class="hd">任务池 <b>{{ poolOpen.length }}</b></div>
          <div v-if="!poolOpen.length" class="empty">— 池子空了 —</div>
          <div v-for="it in poolOpen" :key="it.id" class="card">
            <div class="row">
              <span class="title">{{ it.title }}</span>
              <span class="sp"></span>
              <span class="pmeta">{{ it.children.length ? `已拆 ${it.children.length}` : "未拆" }}</span>
            </div>
            <div v-if="it.note" class="note">{{ it.note }}</div>
            <div class="acts">
              <button class="act" @click="openSplit(it)">拆分</button>
              <button class="act" :disabled="busy === 'push'" @click="pushing = it.id" title="由 DSH 直接写入任务队列，不经过 Claude Code">推入 WB（我写入队列）</button>
              <span class="sp"></span>
              <button class="act danger" @click="removePool(it)">删除</button>
            </div>
            <div v-if="pushing === it.id" class="pushbox">
              <span class="hint" style="margin:0">优先级</span>
              <span class="seg">
                <button v-for="p in ['高', '中', '低']" :key="p" :class="{ on: prio === p }" @click="prio = p">{{ p }}</button>
              </span>
              <span class="sp"></span>
              <button class="act" @click="pushing = null">取消</button>
              <button class="act" @click="doPush">确认推入</button>
            </div>
          </div>

          <div class="newtask">
            <div class="hint">任务标题</div>
            <input id="newTitleInput" v-model="newTitle" type="text" placeholder="一句话标题，比如：修复问卷跳题" @keydown.enter="add" />
            <div class="hint" style="margin-top:12px">任务本身 · 真正发给 Claude Code 的提示词</div>
            <textarea v-model="newBody" rows="3" placeholder="写清：做什么 / 照哪份文档 / 怎么验 / 要什么回执"></textarea>
            <div class="acts" style="margin-top:12px">
              <button class="act" :disabled="busy === 'draft'" @click="optimizeDraft">优化提示词</button>
              <button class="act" @click="openTpl">优化提示词 SKILL</button>
            </div>
            <div class="add">
              <button class="selbtn" @click="projPickOpen = true">{{ currentProjectName }}</button>
              <button class="act" @click="add">加入池</button>
              <button class="act" @click="openProj">＋项目</button>
            </div>
          </div>
        </section>
      </template>

      <!-- 设置 -->
      <template v-if="view === 'settings'">
        <div class="hd">历史会话 <b>{{ s?.history?.runs || 0 }}</b></div>
        <div class="card" style="padding:14px 0">
          <div class="row">
            <span class="title" style="font-size:15px">runs 归档</span>
            <span class="sp"></span>
            <span class="pmeta">{{ s?.history?.runs || 0 }} 个 · {{ fmtBytes(s?.history?.bytes || 0) }}</span>
          </div>
          <div class="note">终端回放和台账都读这里；清理时会连 WSL <code>/tmp</code> 里的 <code>cc-*</code> 一起删（台账、任务表、池子不动）。</div>
          <div class="acts">
            <button class="act" :disabled="busy === 'purge'" @click="purge(24)">清理 24 小时前</button>
            <button class="act" :disabled="busy === 'purge'" @click="purge(168)">清理 7 天前</button>
            <button class="act danger" :disabled="busy === 'purge'" @click="purge(0.01)">全清（1 分钟前）</button>
          </div>
        </div>

        <div class="hd" style="margin-top:44px">已放行的规则 <b>{{ (s?.allowlist || []).length }}</b></div>
        <div class="log">
          <div v-if="!(s?.allowlist || []).length" class="empty">— 还没有放行过 —</div>
          <div v-for="(r, i) in s?.allowlist || []" :key="i" class="line">
            <time>规则</time><span><code>{{ r }}</code></span>
          </div>
        </div>

        <div class="hd" style="margin-top:44px">项目 <b>{{ s?.projects?.length || 0 }}</b></div>
        <div v-for="pr in s?.projects || []" :key="pr.id" class="card" style="padding:14px 0">
          <div class="row">
            <span class="title" style="font-size:16px">{{ pr.name }}</span>
            <span class="pmeta">{{ pr.path }}</span>
            <span class="sp"></span>
            <button class="act danger" @click="delProj(pr.id)">删除</button>
          </div>
        </div>
        <div class="acts" style="margin-top:18px">
          <button class="act" @click="openProj">＋ 添加项目（浏览 WSL 目录）</button>
        </div>

        <div class="hd" style="margin-top:52px">自动整理主表</div>
        <div class="card">
          <div class="row" style="cursor:default; gap:12px; align-items:center">
            <span>每完成</span>
            <input type="number" v-model.number="threshold" min="0" max="99" class="num" />
            <span>条任务，自动建一次整理任务（0 = 关闭）</span>
            <span class="sp"></span>
            <button class="act" @click="saveThreshold">保存</button>
          </div>
          <div class="pmeta" style="margin-top:10px">
            已累计 {{ s?.maintenance?.count || 0 }} 条 · 上次整理 {{ (s?.maintenance?.lastAt || "").slice(0, 16) || "从未" }}
          </div>
        </div>

        <div class="hd" style="margin-top:52px">定时整理（WorkBuddy 侧）</div>
        <div class="card">
          <div class="pmeta">在 WorkBuddy 里建一个每天执行的定时任务，指令用下面这段：</div>
          <div class="acts" style="margin-top:16px"><button class="act" @click="buildCronPrompt">生成指令</button></div>
          <pre v-if="cronPrompt" class="cronbox">{{ cronPrompt }}</pre>
        </div>
      </template>

      <!-- 终端（待授权会以右侧栏形式出现在旁边） -->
      <template v-if="view === 'terminals'">
        <div class="term-head">
          <div>
            <div class="term-title">终端</div>
            <div class="term-sub">{{ termCount ? termCount + " 个会话正在跑" : "当前没有在跑" }} · 共 {{ termTasks.length }} 条 · 1.5 秒刷新</div>
          </div>
          <span class="sp"></span>
          <span v-if="termCount" class="pulse"><i></i>LIVE</span>
        </div>

        <div class="term-grid" :class="{ 'with-rail': pending.length }">
          <div class="term-col">
            <div v-if="!termTasks.length" class="term-empty">
              <div class="te-big">还没有会话</div>
              <div class="te-sub">在任务卡上点「执行」，这里就会出现它的实时输出：思考、命令、结果、回执全文。</div>
            </div>

            <div v-if="fullTerm" class="term-backdrop" @click="fullTerm = null"></div>
            <div class="terms">
              <div v-for="t in termTasks" :key="t.id" class="term" :class="{ live: isRunning(t.id), full: fullTerm === t.id }">
                <div class="term-hd" @click="toggleTerm(t.id)">
                  <span class="dot" :class="{ on: isRunning(t.id) }"></span>
                  <b class="tid">#{{ t.id }}</b>
                  <span class="tsub">{{ t.subject }}</span>
                  <span class="sp"></span>
                  <span v-if="isRunning(t.id)" class="badge live">{{ runningElapsed }}s</span>
                  <span class="tmeta">{{ (raws[t.id] || []).length }} 行</span>
                  <span v-if="t.run?.status" class="tmeta">{{ t.run.status }} · ${{ Number(t.run.cost || 0).toFixed(2) }}</span>
                  <button class="iact" @click.stop="copyTerm(t.id)">复制</button>
                  <button class="iact" @click.stop="fullTerm = fullTerm === t.id ? null : t.id">{{ fullTerm === t.id ? "还原" : "全屏" }}</button>
                  <button class="iact danger" @click.stop="delRun(t)">删除</button>
                </div>
                <pre v-if="termOpen[t.id]" :ref="(el) => setTermEl(t.id, el)" class="term-body" @scroll="onTermScroll(t.id)"><template v-for="(l, i) in raws[t.id] || []" :key="i"><span :class="'l-' + l.kind">{{ l.text }}</span>
</template></pre>
                <button v-if="termOpen[t.id] && !isAtBottom(t.id)" class="jump" @click.stop="scrollBottom(t.id)">↓ 底部</button>
                <div v-if="termOpen[t.id] && isRunning(t.id) && !(raws[t.id] || []).length" class="term-wait">会话已启动，等待第一条输出…</div>
                <div v-if="!termOpen[t.id]" class="term-collapsed">已收起 · 点标题行展开</div>
              </div>
            </div>
          </div>

          <!-- 待授权：贴在终端右侧，不再单独开一页 -->
          <aside v-if="pending.length" class="auth-rail">
            <div class="rail-hd">
              <span class="pulse warn"><i></i>AUTH</span>
              <b>{{ pending.length }}</b><span class="tmeta">条等你批</span>
            </div>
            <div v-for="a in pending" :key="a.id" class="auth-card">
              <div class="ac-hd">Claude Code 想执行</div>
              <div class="ac-cmd">{{ cmdText(a) }}</div>
              <div class="ac-rule">建议放行 <code>{{ (a.suggested || []).join(" ") || "（无建议）" }}</code></div>
              <div class="ac-acts">
                <button class="act" @click="approve(a.id)">批准</button>
                <button class="act danger" @click="reject(a.id)">拒绝</button>
              </div>
            </div>
            <div class="rail-note">批准会写进 allowlist，并按原任务重派一次。</div>
          </aside>
        </div>
      </template>

      <!-- 已完成 -->
      <template v-if="view === 'done'">
        <div class="hd">已完成 <b>{{ doneTasks.length }}</b></div>
        <div v-if="!doneTasks.length" class="empty">— 还没有已完成的任务 —</div>
        <div v-for="t in doneTasks" :key="t.id" class="card" style="padding:12px 0">
          <div class="row">
            <span class="title" style="font-size:14px">#{{ t.id }} {{ t.subject }}</span>
            <span class="sp"></span>
            <span class="pmeta">{{ t.evidence ? t.evidence.slice(0, 40) : "无证据" }}</span>
          </div>
        </div>
        <div class="hd" style="margin-top:36px">归档的池子 <b>{{ poolDone.length }}</b></div>
        <div v-for="it in poolDone" :key="it.id" class="card" style="padding:10px 0">
          <div class="row">
            <span class="title" style="font-size:14px">{{ it.title }}</span>
            <span class="sp"></span>
            <span class="pmeta">{{ it.priority || "中" }} · #{{ it.pushTaskId }}</span>
          </div>
        </div>
      </template>

      <!-- WorkBuddy -->
      <template v-if="view === 'wb'">
        <div class="hd">WorkBuddy 调用 <b>{{ wb.length }}</b></div>
        <div class="log">
          <div v-if="!wb.length" class="empty">— 还没有调用 —</div>
          <div v-for="(e, i) in wb" :key="i" class="line">
            <time>{{ (e.at || "").slice(11, 16) }}</time>
            <span>{{ e.ok ? "✓" : "✗" }} <b>{{ e.tool }}</b> <code>{{ e.args }}</code></span>
          </div>
        </div>
      </template>

      <!-- 文档 -->
      <template v-if="view === 'docs'">
        <iframe class="docframe" src="/wiki" title="wiki"></iframe>
      </template>
    </main>

    <div v-if="projPickOpen" class="overlay" @click.self="projPickOpen = false">
      <div class="sheet">
        <h3>选项目</h3>
        <div class="dirs" style="max-height:320px">
          <div v-for="pr in s?.projects || []" :key="pr.id" class="dir" :class="{ picked: pr.path === newProject }" @click="pickProject(pr.path)">
            {{ pr.name }} <span class="pmeta">{{ pr.path }}</span>
          </div>
          <div v-if="!(s?.projects || []).length" class="empty">— 还没有项目 —</div>
        </div>
        <div class="row2">
          <button class="act" @click="projPickOpen = false; openProj()">＋ 新项目</button>
          <button class="act" @click="projPickOpen = false">关闭</button>
        </div>
      </div>
    </div>

    <div v-if="projOpen" class="overlay" @click.self="projOpen = false">
      <div class="sheet">
        <h3>添加项目</h3>
        <div class="hint">项目名</div>
        <input type="text" v-model="projName" placeholder="比如 Vesta / LosPool" />
        <div class="hint" style="margin-top:16px">目录（点文件夹进入，选好后确认）</div>
        <div class="pmeta" style="margin-bottom:10px">{{ projPath }}</div>
        <div class="acts" style="margin-top:0">
          <button class="act" @click="browse('~')">~ 主页</button>
          <button class="act" v-if="projParent" @click="browse(projParent)">↑ 上一层</button>
          <span v-if="projErr" class="pmeta">{{ projErr }}</span>
        </div>
        <div class="dirs">
          <div v-for="d in projDirs" :key="d" class="dir" @click="browse(projPath.endsWith('/') ? projPath + d : projPath + '/' + d)">
            {{ d }}/
          </div>
          <div v-if="!projDirs.length" class="empty">— 这里没有子目录 —</div>
        </div>
        <div class="row2">
          <button class="act" @click="projOpen = false">取消</button>
          <button class="act" @click="saveProj">选用此目录</button>
        </div>
      </div>
    </div>

    <div v-if="splitItem" class="overlay" @click.self="splitItem = null">
      <div class="sheet">
        <h3>拆分 · {{ splitItem.title }}</h3>
        <div class="hint">需求/提示词（可改，改完让 AI 拆）</div>
        <textarea v-model="splitPrompt" rows="4"></textarea>
        <div class="acts">
          <button class="act" :disabled="splitBusy" @click="optimizeSplitPrompt">优化</button>
          <button class="act" :disabled="splitBusy" @click="aiSplit">让 AI 拆</button>
          <button class="act" @click="addManualLine">加一行</button>
          <span class="sp"></span>
          <button class="act" @click="openTpl">优化SKILL设置</button>
        </div>

        <div v-if="splitList.length" class="splited">
          <div class="hint">勾选要加入池子的子任务（本体也留在池子里，地位一样）</div>
          <div v-for="(x, i) in splitList" :key="i" class="splitrow">
            <input type="checkbox" v-model="x.on" />
            <input type="text" v-model="x.title" placeholder="子任务标题" />
            <select v-model="x.owner" class="sel">
              <option value="claude-code">CC</option>
              <option value="workbuddy">WB</option>
            </select>
          </div>
        </div>

        <div class="row2">
          <button class="act" @click="splitItem = null">取消</button>
          <button class="act" :disabled="splitBusy || !splitList.length" @click="applySplit">加入池子</button>
        </div>
      </div>
    </div>

    <div v-if="tplOpen" class="overlay" @click.self="tplOpen = false">
      <div class="sheet">
        <h3>优化 SKILL 设置</h3>
        <div class="hint">拆分用的系统提示</div>
        <textarea v-model="tpl.splitSystem" rows="4"></textarea>
        <div class="hint" style="margin-top:16px">改写提示词用的系统提示</div>
        <textarea v-model="tpl.optimizeSystem" rows="4"></textarea>
        <div class="row2">
          <button class="act" @click="tplOpen = false">取消</button>
          <button class="act" @click="saveTpl">保存</button>
        </div>
      </div>
    </div>

    <div v-if="sheet" class="overlay" @click.self="sheet = null">
      <div class="sheet">
        <h3>{{ sheet.title }}</h3>
        <template v-if="sheet.json">
          <div v-if="sheet.json.requirement" class="sect"><h4>需求描述</h4><pre>{{ sheet.json.requirement }}</pre></div>
          <div v-if="sheet.json.deliverables" class="sect"><h4>交付事项</h4><ul><li v-for="(x, i) in sheet.json.deliverables" :key="i">{{ x }}</li></ul></div>
          <div v-if="sheet.json.acceptance" class="sect"><h4>验收事项</h4><ul><li v-for="(x, i) in sheet.json.acceptance" :key="i">{{ x }}</li></ul></div>
          <div v-if="Array.isArray(sheet.json)" class="sect"><h4>建议</h4><ul><li v-for="(x, i) in sheet.json" :key="i">{{ x.title }} <span class="badge">{{ x.owner }}</span></li></ul></div>
        </template>
        <pre v-else>{{ sheet.body }}</pre>
        <div class="row2"><button class="act" @click="copySheet">复制</button><button class="act" @click="sheet = null">关闭</button></div>
      </div>
    </div>
  </div>
</template>
