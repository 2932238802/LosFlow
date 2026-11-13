// 与服务端 /api/state 契约对齐的类型（见 docs/architecture.md「关键契约」）

export type Area = { kind: "code" | "docs"; path: string };

// 派单执行环境：WSL2 项目走 WSL2 的 Claude Code，Windows 项目走本机 Claude Code
export type EnvName = "wsl" | "windows";
export type EnvMode = "auto" | EnvName;

// 工作类型：加入池子时就定下来，优化提示词 / 标记完成 / 回填都沿用它
export type WorkType = "dev" | "docs" | "plan";

export type PoolItem = {
  id: string;
  title: string;
  // 任务本身（真正发给 Claude Code 的正文）；拆出来的子条目必填
  note: string;
  kind?: string;
  stage: "pool" | "split" | "pushed" | string;
  // 父条目：这里存子条目的 pool id；推入后的任务 id 在 pushedTaskIds
  children: string[];
  pushTaskId: string | null;
  priority?: string;
  project?: string;
  // 创建时分配；子条目默认继承父条目，可单独改
  workType?: WorkType;
  // 子条目：父条目 id + owner；没有父条目（历史数据）时 parent 指向已删除的 id
  parent?: string;
  owner?: string;
  pushedTaskIds?: string[];
  splitCount?: number;
  splitAt?: number;
  pushedAt?: number;
  updatedAt?: number;
};

export type DocSync = { status?: string; attempts?: number; doneAt?: number } | null;

export type TaskRun = { id?: string; at?: string; status?: string; cost?: number | null; turns?: number; env?: EnvName };

export type Starting = { at?: number; kind?: string } | null;

export type Task = {
  id: string;
  subject: string;
  owner: string;
  status: string;
  evidence: string;
  note?: string;
  repo?: string;
  // 派单执行环境（服务端按 repo 解析后的结果）
  env?: EnvName;
  envMode?: EnvMode;
  // 会话来自哪个环境：与当前 env 不一致时不允许续接
  sessionEnv?: EnvName | "";
  // 最近一次派单的环境检查 / 错误（preflight 时没有台账，靠这个提示）
  lastError?: string;
  lastErrorAt?: number | null;
  lastErrorStatus?: string;
  kind?: string;
  type?: string;
  updatedAt?: number;
  sessionId?: string;
  // 工作类型在创建/推入时就定；review 是旧数据，读时按「文档」处理
  workType?: WorkType | "review";
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

export type RunDetail = { id: string; at: string; status: string; env?: EnvName; cost: number | null; turns: number; session?: string; result: string };

export type Approval = {
  id: string;
  at?: string;
  expiredAt?: string;
  commands?: string[];
  cmd?: string;
  suggested: string[];
  dispatch?: string;
  status: string;
  // live：执行前同步问人（同一次 run 继续，不重派）
  live?: boolean;
  // midRun：已经发生的拒绝（降级 C），批准仍需重派一次
  midRun?: boolean;
  runId?: string;
  taskId?: string;
  taskSubject?: string;
  tool?: string;
  expiresAt?: number;
  atMs?: number;
  waitedMs?: number;
  error?: string;
  note?: string;
  repo?: string;
  env?: EnvName | "";
  decidedAt?: string;
  approvedAt?: string;
  rejectedAt?: string;
  rejectNote?: string;
  retryNote?: string;
};

export type Project = { id: string; name: string; path: string; env?: EnvMode; resolvedEnv?: EnvName };
export type TerminalRun = { id: string; pid: number; startedAt: string; env?: EnvName; taskId?: string; repo?: string };
export type WbCall = { at?: string; tool?: string; ok?: boolean; args?: unknown };

export type NotifyStatus = { enabled: boolean; ok?: boolean; mode?: string; lastAt?: string; lastError?: string };

export type State = {
  now?: string;
  projects: Project[];
  defaultEnv?: EnvName;
  maintenance?: { count?: number; threshold?: number; lastAt?: string };
  pool: PoolItem[];
  docsync?: { pending?: number; byTask?: Record<string, DocSync> } | null;
  terminals?: { count: number; items: TerminalRun[]; ok?: boolean };
  history?: { runs: number; streams?: number; bytes: number };
  approvals: Approval[];
  allowlist?: string[];
  notify?: NotifyStatus;
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
  // 回执缺金额（网关异常 / 订阅态）时为 null，界面显示「—」
  cost?: number | null;
} | null;

export type TermStats = {
  rounds: number;
  tools: number;
  errors: number;
  files: number;
  filesChanged: string[];
  turns: number;
  durationMs: number;
  cost: number | null;
  lastEventAt: number;
};

export type TermHistory = {
  dispatch?: string;
  source: "archive" | "wsl" | "windows" | "missing";
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
