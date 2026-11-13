// 与服务端 /api/state 契约对齐的类型（见 docs/architecture.md「关键契约」）

export type Area = { kind: "code" | "docs"; path: string };

export type ConfirmBits = { detail: boolean; flow: boolean; auth: boolean };

export type PoolItem = {
  id: string;
  title: string;
  note: string;
  kind?: string;
  stage: string;
  children: string[];
  pushTaskId: string | null;
  priority?: string;
  project?: string;
  confirm?: ConfirmBits;
};

export type DocSync = { status?: string; attempts?: number; doneAt?: number } | null;

export type TaskRun = { id?: string; at?: string; status?: string; cost?: number; turns?: number };

export type Starting = { at?: number; kind?: string } | null;

export type Task = {
  id: string;
  subject: string;
  owner: string;
  status: string;
  evidence: string;
  note?: string;
  repo?: string;
  kind?: string;
  type?: string;
  updatedAt?: number;
  sessionId?: string;
  workType?: string;
  area?: Area | null;
  finishedAt?: number | null;
  // 纯文档同步类任务（历史遗留）：不进任务/终端/已完成，证据仍留在任务表
  docOnly?: boolean;
  nudgedAt?: string;
  nudges?: number;
  docSync?: DocSync;
  wb?: { takenAt?: string; reportedAt?: string; reportStatus?: string } | null;
  // 列表里只带轻量字段；回执全文走 GET /api/task/run
  run?: TaskRun | null;
  // 已投递、子进程还没接管的空窗（服务端 pending.json）
  starting?: Starting;
  // 这张卡自己的活会话 runId（并发派单时不会串台）
  running?: string | null;
};

export type RunDetail = { id: string; at: string; status: string; cost: number; turns: number; session?: string; result: string };

export type Approval = {
  id: string;
  commands?: string[];
  cmd?: string;
  suggested: string[];
  dispatch?: string;
  status: string;
};

export type Project = { id: string; name: string; path: string };
export type TerminalRun = { id: string; pid: number; startedAt: string };
export type WbCall = { at?: string; tool?: string; ok?: boolean; args?: unknown };

export type State = {
  now?: string;
  projects: Project[];
  maintenance?: { count?: number; threshold?: number; lastAt?: string };
  pool: PoolItem[];
  docsync?: { pending?: number; byTask?: Record<string, DocSync> } | null;
  terminals?: { count: number; items: TerminalRun[]; ok?: boolean };
  history?: { runs: number; streams?: number; bytes: number };
  approvals: Approval[];
  allowlist?: string[];
  tasks: Task[];
  calls?: WbCall[];
  spendToday: number;
  running?: { id: string; taskId?: string; startedAt?: string; task?: string } | null;
};

export type RawLine = {
  kind: string;
  text: string;
  seq?: number;
  msgId?: string;
  actionId?: string;
  tool?: string;
  input?: Record<string, any>;
  ok?: boolean;
  at?: string;
};

// 6 号契约：轮 + 动作
export type TermAction = {
  id: string;
  tool: string;
  input: Record<string, any>;
  ok: boolean;
  ms?: number | null;
  out: string;
  err?: string | null;
  at?: string;
};

export type TermRound = {
  i: number;
  msgId?: string;
  at?: string;
  status: string;
  think: string;
  say: string;
  actions: TermAction[];
};

export type TermEnd = {
  status: string;
  result: string;
  durationMs?: number;
  turns?: number;
  cost?: number;
} | null;

export type TermStats = {
  rounds: number;
  tools: number;
  errors: number;
  files: number;
  filesChanged: string[];
  turns: number;
  durationMs: number;
  cost: number;
  lastEventAt: number;
};

export type TermHistory = {
  dispatch?: string;
  source: "archive" | "wsl" | "missing";
  running?: boolean;
  truncated: boolean;
  hasMore: boolean;
  totalRounds: number;
  stats: TermStats;
  rounds: TermRound[];
  end: TermEnd;
  lines?: RawLine[];
};

export type View = "tasks" | "terminals" | "done" | "wb" | "settings";

export const VIEWS: View[] = ["tasks", "terminals", "done", "wb", "settings"];
export const VIEW_KEY = "losflow.view";

export function loadView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY) as View | null;
    if (v && VIEWS.includes(v)) return v;
  } catch {
    /* 隐私模式之类，忽略 */
  }
  return "tasks";
}
