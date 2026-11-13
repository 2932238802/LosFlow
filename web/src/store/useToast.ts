import { ref } from "vue";

export const msg = ref("");
export const err = ref(false);

export function flash(t: string, isErr = false) {
  msg.value = t;
  err.value = isErr;
  clearTimeout((flash as any)._t);
  (flash as any)._t = setTimeout(() => (msg.value = ""), isErr ? 7000 : 3200);
}
