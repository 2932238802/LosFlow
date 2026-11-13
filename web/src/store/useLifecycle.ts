import { onBeforeUnmount, onMounted } from "vue";
import { nowMs, refresh, s } from "./useAppState";
import { loadJobs } from "./useJobs";
import { applyStream, reconcile } from "./useTerminal";
import { closeWb, connectWb } from "./useWb";

// 全局只在这里起连接/定时器，避免组件各自 setInterval。
//   状态：5s 轮询兜底；有 live 授权等待时自动加快到 1s（SSE 断了也不会退回 5s+）
//   心跳：1s（只更新 nowMs，给「已等 N 分钟 / 剩余 N 秒」用）
//   终端：一条 /events/losflow SSE，服务端增量推，不再 2s 整包重取
let timer = 0;
let nowTimer = 0;
let termEs: EventSource | null = null;
let retryTimer = 0;

function hasLiveWaiting() {
  return (s.value?.approvals || []).some((a) => a.live && a.status === "pending");
}

function schedule(delay: number) {
  window.clearTimeout(timer);
  timer = window.setTimeout(async () => {
    await refresh();
    loadJobs();
    schedule(hasLiveWaiting() ? 1000 : 5000);
  }, delay);
}

function connectTerms() {
  if (termEs || location.search.includes("static")) return;
  const es = new EventSource("/events/losflow");
  termEs = es;
  es.onopen = () => {
    // 重连成功（或首次连上）就对一次账：断线期间缺的行按 seq 补回来
    if (termEs === es) reconcile();
  };
  es.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data);
      // 审批事件没有 taskId：立即刷新状态，让 dock / 悬浮卡在 1s 内出现 / 消失
      if (e?.kind === "approval") {
        refresh();
        return;
      }
      applyStream(e);
    } catch {
      /* 坏消息跳过 */
    }
  };
  es.onerror = () => {
    if (termEs !== es) return;
    try { es.close(); } catch { /* ignore */ }
    termEs = null;
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(connectTerms, 3000);
  };
}

function closeTerms() {
  termEs?.close();
  termEs = null;
  window.clearTimeout(retryTimer);
}

// 浏览器冻结后台 / 切走再回来：先对账再把连接补齐，不让用户 F5。
function onVisibility() {
  if (document.visibilityState !== "visible") return;
  if (!termEs) connectTerms();
  reconcile();
}

export function useLifecycle() {
  onMounted(() => {
    // 拆分等后台作业：刷新页面后靠这里把「拆分中 / 有结果」补回来
    loadJobs();
    connectWb();
    connectTerms();
    document.addEventListener("visibilitychange", onVisibility);
    // 首次刷新完再决定节奏：页面打开时已经有 live 请求就直接用 1s
    refresh().then(() => schedule(hasLiveWaiting() ? 1000 : 5000));
    nowTimer = window.setInterval(() => (nowMs.value = Date.now()), 1000);
  });
  onBeforeUnmount(() => {
    window.clearTimeout(timer);
    clearInterval(nowTimer);
    document.removeEventListener("visibilitychange", onVisibility);
    closeWb();
    closeTerms();
  });
}
