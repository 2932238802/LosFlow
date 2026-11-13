import { ref } from "vue";
import { getJSON } from "../api";
import type { State } from "../types";
import { seedWb } from "./useWb";

export const s = ref<State | null>(null);
export const nowMs = ref(Date.now());
// 页面级忙碌标记：任务 id、或 "purge" / "push" / "draft" / "stop"
export const busy = ref("");

export async function refresh() {
  try {
    s.value = await getJSON<State>("/api/state");
    seedWb(s.value.calls);
  } catch {
    /* offline */
  }
}
