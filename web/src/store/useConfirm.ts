import { ref } from "vue";

// 统一的确认层：破坏性动作（删除任务/池条目/会话、重新打开）都走它，
// 不再混用 window.confirm / 直接执行。
export type ConfirmOptions = {
  title: string;
  body?: string;
  detail?: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
};

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

export const confirmReq = ref<Pending | null>(null);

export function askConfirm(opts: ConfirmOptions): Promise<boolean> {
  // 上一个没答完就问下一个：按「取消」处理，避免悬空 Promise
  confirmReq.value?.resolve(false);
  return new Promise((resolve) => {
    confirmReq.value = { ...opts, resolve };
  });
}

export function answerConfirm(ok: boolean) {
  const cur = confirmReq.value;
  confirmReq.value = null;
  cur?.resolve(ok);
}
