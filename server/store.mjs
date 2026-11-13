// store.mjs -- data/*.json 的统一读写。
//
// 两个约定：
//   1) 读：坏文件/不存在都返回 fallback，不抛。
//   2) 写：一律走 mutate()，同一个进程内的「读-改-写」串行排队，绝不并发覆盖。
//      （异步派单后写入落在 setImmediate / 定时器里，不串行会丢更新：刚标完成的任务被改回 todo。）
//
// mutate 的 fn 拿到的是「当前文件内容」，返回值就是新内容（返回 undefined 视为不修改）。
// 写临时文件再 rename：Windows 上 Node 的 rename 会覆盖已存在的目标，读方永远看不到半截 JSON。

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";

export function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeAtomic(file, value) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, file);
}

// 进程内唯一的写入链。链上的错误被吞掉，避免一次失败让后续写入全部拒绝；
// 本次调用的 Promise 仍然把错误抛给调用方。
let chain = Promise.resolve();

export function mutate(file, fn) {
  const job = chain.then(() => {
    const cur = readJson(file, null);
    const next = fn(cur);
    const out = next === undefined ? cur : next;
    writeAtomic(file, out);
    return out;
  });
  chain = job.then(
    () => undefined,
    () => undefined
  );
  return job;
}

// 立即写（初始化种子文件之类，不进队列）
export function writeJson(file, value) {
  writeAtomic(file, value);
}
