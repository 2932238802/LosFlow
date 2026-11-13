#!/bin/bash
# 由驾驶舱调用：数正在跑的 Claude Code 终端 / 清理 /tmp 里的历史产物。
#
# 必须写成脚本文件再执行：
# 直接 wsl.exe -- bash -lc '...带引号的命令...' 时，wsl.exe 会把内层引号吃掉，
# 导致 $(cat "$f") 变成 $(cat "") —— 之前「明明在跑却显示 0」就是这个原因。
set -u

if [ "${1:-}" = "purge" ]; then
  minutes="${2:-1440}"
  find /tmp -maxdepth 1 -name 'cc-*' -mmin +"$minutes" -delete -print 2>/dev/null | wc -l
  exit 0
fi

# delete <runId>：删这一条会话在 WSL 里的全部产物；还在跑就拒绝
if [ "${1:-}" = "delete" ]; then
  id="${2:-}"
  case "$id" in
    '' | *[!0-9a-zA-Z-]*) echo "BADID"; exit 2 ;;
  esac
  pidfile="/tmp/cc-$id.pid"
  if [ -e "$pidfile" ]; then
    p=$(cat "$pidfile" 2>/dev/null)
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
      echo "ALIVE"
      exit 1
    fi
  fi
  n=$(find /tmp -maxdepth 1 -name "cc-$id.*" | wc -l)
  rm -f /tmp/cc-"$id".* 2>/dev/null
  echo "$n"
  exit 0
fi

for f in /tmp/cc-*.pid; do
  [ -e "$f" ] || continue
  p=$(cat "$f" 2>/dev/null)
  [ -n "$p" ] || continue
  if kill -0 "$p" 2>/dev/null; then
    echo "$(basename "$f" .pid)|$p"
  fi
done
