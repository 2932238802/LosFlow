// 「新建任务」输入框的聚焦：删除池子/任务后把文字放回输入框并选中。
// 输入框在 NewTaskBox 里，组件挂载时注册自己的聚焦函数，避免跨文件 getElementById。
let focusFn: (() => void) | null = null;

export function registerNewTaskFocus(fn: (() => void) | null) {
  focusFn = fn;
}

export function focusNew() {
  setTimeout(() => focusFn?.(), 30);
}
