import { onBeforeUnmount, onMounted } from "vue";
import { nowMs, refresh } from "./useAppState";
import { applyStream } from "./useTerminal";
import { closeWb, connectWb } from "./useWb";

// 全局只在这里起连接/定时器，避免组件各自 setInterval。
//   状态：5s 轮询兜底（终端扫描本身有 20s 缓存，不会每轮 spawn wsl）
//   心跳：1s（只更新 nowMs，给「已等 N 分钟」用）
//   终端：一条 /events/losflow SSE，服务端增量推，不再 2s 整包重取
let timer = 0;
let nowTimer = 0;
let termEs: EventSource | null = null;

function connectTerms() {
  if (termEs || location.search.includes("static")) return;
  termEs = new EventSource("/events/losflow");
  termEs.onmessage = (m) => {
    try {
      applyStream(JSON.parse(m.data));
    } catch {
      /* 坏消息跳过 */
    }
  };
}

function closeTerms() {
  termEs?.close();
  termEs = null;
}

export function useLifecycle() {
  onMounted(() => {
    refresh();
    connectWb();
    connectTerms();
    timer = window.setInterval(refresh, 5000);
    nowTimer = window.setInterval(() => (nowMs.value = Date.now()), 1000);
  });
  onBeforeUnmount(() => {
    clearInterval(timer);
    clearInterval(nowTimer);
    closeWb();
    closeTerms();
  });
}
