import { computed } from "vue";
import { post } from "../api";
import type { ConnectorView } from "../types";
import { refresh, s } from "./useAppState";
import { flash } from "./useToast";

// 连接器状态来自 /api/state.connectors；保存/测试/重放后 refresh 重新取。
export const connectorList = computed<ConnectorView[]>(() => s.value?.connectors || []);

export async function saveConnector(input: {
  id: string;
  enabled?: boolean;
  target?: Record<string, any>;
  mapping?: Record<string, any>;
  actions?: string[];
  match?: Record<string, any>;
  queue?: Record<string, any>;
  secret?: string;
  clearSecret?: boolean;
}) {
  try {
    const r = await post("/api/connectors", input);
    await refresh();
    flash(`连接器 ${input.id} 已保存`);
    return r.connector;
  } catch (e: any) {
    flash(e.message, true);
    throw e;
  }
}

export async function testConnector(id: string) {
  try {
    const r = await post("/api/connectors/test", { id });
    await refresh();
    flash(`已给 ${id} 发测试行（${r.job?.id || "job"}）`);
  } catch (e: any) {
    flash(e.message, true);
  }
}

export async function replayConnector(id = "") {
  try {
    const r = await post("/api/connectors/replay", { id });
    await refresh();
    flash(`已重放 ${r.replayed || 0} 条失败同步`);
  } catch (e: any) {
    flash(e.message, true);
  }
}
