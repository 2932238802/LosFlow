import { ref, watch } from "vue";
import { VIEW_KEY, loadView, type View } from "../types";

export const view = ref<View>(loadView());

export function setView(v: View) {
  view.value = v;
}

// 刷新/重开保持上次停留的页面，不默认跳回「任务」
watch(view, (v) => {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* ignore */
  }
});
