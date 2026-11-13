// useJobs.ts -- 后台作业的前端视图（目前只有「让 AI 拆」）。
//
// 以前拆分是一次长 await：弹层关掉、刷新页面，结果就丢了，按钮还会一直灰。
// 现在服务端立刻返回 jobId，这里每秒轮询一次；终态写进 jobs，池子行和弹层都从
// 「作业状态」渲染，不再由某一次请求的栈帧驱动。
//
// 后台标签页降频到 5 s：看不见的页面不打点。

import { reactive } from "vue";
import { getJSON } from "../api";

export type JobStatus = "running" | "ok" | "failed";

export type Job = {
  id: string;
  kind: string;
  key: string;
  label: string;
  status: JobStatus;
  at: number;
  startedAt: number;
  doneAt?: number;
  elapsedMs?: number;
  result?: string;
  error?: string;
  cost?: number | null;
  via?: string;
};

export const jobs = reactive<Record<string, Job>>({});

const timers = new Map<string, number>();
const dones = new Map<string, Set<(j: Job) => void>>();

function later(fn: () => void, ms: number) {
  return window.setTimeout(fn, ms);
}

// 同 kind + key 的最新一条作业（running 一定比旧终态新，因为 startJob 用当前时间）
export function jobFor(key: string, kind = "pool.suggest"): Job | null {
  let best: Job | null = null;
  for (const j of Object.values(jobs)) {
    if (j.kind !== kind || j.key !== key) continue;
    if (!best || Number(j.at || 0) >= Number(best.at || 0)) best = j;
  }
  return best;
}

export async function loadJobs(kind = "pool.suggest"): Promise<Job[]> {
  try {
    const r = await getJSON<{ jobs: Job[] }>(`/api/jobs?kind=${encodeURIComponent(kind)}`);
    const list = Array.isArray(r?.jobs) ? r.jobs : [];
    for (const j of list) jobs[j.id] = j;
    return list;
  } catch {
    return [];
  }
}

// 轮询一个 job 到终态。重复调用只是追加回调，不会起第二个定时器。
export function watchJob(id: string, onDone?: (j: Job) => void) {
  if (!id) return;
  if (onDone) {
    const set = dones.get(id) || new Set();
    set.add(onDone);
    dones.set(id, set);
  }
  if (timers.has(id)) return;

  const tick = async () => {
    timers.delete(id);
    let j: Job | null = null;
    try {
      j = await getJSON<Job>(`/api/job?id=${encodeURIComponent(id)}`);
      if (!j || !j.id) throw new Error("bad job");
      jobs[j.id] = j;
    } catch {
      // 服务端暂时不可达：别把界面卡成「永远拆分中」，3 s 后再试
      timers.set(id, later(tick, 3000));
      return;
    }
    if (j.status === "running") {
      timers.set(id, later(tick, document.hidden ? 5000 : 1000));
      return;
    }
    const set = dones.get(id);
    dones.delete(id);
    if (set) for (const fn of set) {
      try { fn(j); } catch { /* 单个回调失败不影响别的 */ }
    }
  };

  timers.set(id, later(tick, 0));
}
