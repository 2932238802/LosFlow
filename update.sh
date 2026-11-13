#!/usr/bin/env bash
# update.sh -- 重建前端 + 用「本仓库」的服务接管驾驶舱端口，并验证接管成功。
#
# 解决的问题：
#   旧 checkout（比如迁移前的 D:\PROJECT\Ds\tools\dashboard）残留的进程一直占着
#   8899，DSH 面板 iframe 打开的还是旧前端、旧接口 —— 新代码像没生效一样。
#   这个脚本会先找到端口的真实占用者，换成当前仓库的 server.mjs，再核对：
#     1) 监听端口的 PID 就是刚刚启动的进程；
#     2) /app/ 返回的前端产物哈希与 web/dist 一致；
#   任意一条不满足就报错退出，不再出现「看起来更新了其实没有」。
#
# 用法：
#   ./update.sh                 # 构建 + 检查 + 重启（默认）
#   ./update.sh --no-build      # 只重启，不构建
#   ./update.sh --no-check      # 跳过类型检查 / 单测 / 冒烟
#   ./update.sh --check-only    # 只构建 + 检查，不重启服务
#   ./update.sh --port 8900     # 指定端口（默认 LOSFLOW_PORT / losflow.config.json / 8899）
#   ./update.sh --force         # 端口被非 server.mjs 进程占用时也强杀；有任务在跑时也重启
#   ./update.sh -h              # 帮助
#
# 检查使用隔离的数据目录，不会和正在跑的服务抢 data/；有任务在跑时默认
# 拒绝重启（--force 跳过）。构建的是当前工作区代码，不会自动 git pull。
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT" || { echo "✗ 进不去仓库目录"; exit 1; }

PORT_ARG=""
DO_BUILD=1
DO_CHECK=1
CHECK_ONLY=0
FORCE=0

die() { echo "✗ $*" >&2; exit 1; }
info() { echo "→ $*"; }
usage() {
  cat <<'EOF'
update.sh -- 重建前端 + 用本仓库的服务接管驾驶舱端口，并验证接管成功。

用法：
  ./update.sh                 构建 + 检查 + 重启（默认）
  ./update.sh --no-build      只重启，不构建
  ./update.sh --no-check      跳过类型检查 / 单测 / 冒烟
  ./update.sh --check-only    只构建 + 检查，不重启服务
  ./update.sh --port 8900     指定端口（默认 LOSFLOW_PORT / losflow.config.json / 8899）
  ./update.sh --force         端口被非 server.mjs 进程占用时也强杀；有任务在跑时也重启
  ./update.sh -h              帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) DO_BUILD=0 ;;
    --no-check) DO_CHECK=0 ;;
    --check-only) CHECK_ONLY=1 ;;
    --port) shift; [ $# -gt 0 ] || die "--port 后面要跟端口号"; PORT_ARG="$1" ;;
    --force) FORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "不认识的参数：$1（用 --help 看用法）" ;;
  esac
  shift
done

command -v node >/dev/null 2>&1 || die "找不到 node（需要 Node >= 20）"
NODE_VER="$(node -p 'process.versions.node')"
NODE_MAJOR="${NODE_VER%%.*}"
case "$NODE_MAJOR" in ''|*[!0-9]*) die "读不到 Node 版本：$NODE_VER" ;; esac
[ "$NODE_MAJOR" -ge 20 ] || die "Node $NODE_VER 太旧（需要 >= 20）"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) PLATFORM=win ;;
  *) PLATFORM=unix ;;
esac

# 端口：参数 > LOSFLOW_PORT > losflow.config.json > 8899（与 server/paths.mjs 的优先级一致）
if [ -n "$PORT_ARG" ]; then
  PORT="$PORT_ARG"
else
  PORT="${LOSFLOW_PORT:-}"
  if [ -z "$PORT" ]; then
    PORT="$(node -p "try{require('./losflow.config.json').dashboardPort||''}catch(e){''}" 2>/dev/null || true)"
  fi
  [ -n "$PORT" ] || PORT=8899
fi

case "$PORT" in
  ''|*[!0-9]*) die "端口不合法：$PORT" ;;
esac

winpath() { cygpath -w "$1" 2>/dev/null || printf '%s' "$1"; }

find_pids() {
  if [ "$PLATFORM" = win ]; then
    netstat -ano 2>/dev/null | awk -v p=":$PORT" \
      '$1=="TCP" && substr($2, length($2)-length(p)+1)==p && $4=="LISTENING" {print $NF}' | sort -u
  elif command -v lsof >/dev/null 2>&1; then
    lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null | sort -u
  elif command -v ss >/dev/null 2>&1; then
    ss -lptn "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
  fi
}

proc_cmdline() {
  if [ "$PLATFORM" = win ]; then
    powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=$1').CommandLine" 2>/dev/null \
      | tr -d '\r' | sed '/^[[:space:]]*$/d'
  else
    ps -p "$1" -o args= 2>/dev/null || true
  fi
}

kill_pid() {
  if [ "$PLATFORM" = win ]; then
    powershell -NoProfile -Command "Stop-Process -Id $1 -Force -ErrorAction SilentlyContinue" >/dev/null 2>&1 || true
  else
    kill -9 "$1" 2>/dev/null || true
  fi
}

# ---------- 1. 先构建：构建失败就不动正在跑的服务 ----------
if [ "$DO_BUILD" = 1 ]; then
  command -v npm >/dev/null 2>&1 || die "找不到 npm"
  if [ ! -d web/node_modules ]; then
    info "首次构建：安装 web 依赖"
    npm --prefix web install || die "web 依赖安装失败"
  fi
  info "构建前端（web/dist）"
  npm run build || die "前端构建失败，当前服务未动"
fi

[ -f web/dist/index.html ] || die "web/dist/index.html 不存在，先跑一次构建"
EXPECT="$(grep -o 'assets/index-[^"]*\.js' web/dist/index.html | head -1 || true)"
[ -n "$EXPECT" ] || die "web/dist/index.html 里找不到前端产物，构建可能不完整"

command -v curl >/dev/null 2>&1 || die "找不到 curl（健康检查需要）"

# ---------- 1.5 重启保护：有任务在跑就不动服务（--force 可跳过） ----------
live_state() { curl -s --max-time 3 "http://127.0.0.1:$PORT/api/state" 2>/dev/null || true; }
assert_no_live_runs() {
  [ "$FORCE" = 1 ] && return 0
  ST="$(live_state)"
  BUSY=""
  if [ -n "$ST" ]; then
    BUSY="$(printf '%s' "$ST" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);let b=(j.tasks||[]).filter(t=>t.running||t.starting).map(t=>'#'+t.id);if(!b.length&&j.running&&j.running.taskId)b=['#'+j.running.taskId];if(b.length)process.stdout.write(b.join(' '))}catch(e){}})")"
  fi
  JOBS="$(curl -s --max-time 3 "http://127.0.0.1:$PORT/api/jobs?kind=pool.suggest" 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const r=(j.jobs||[]).filter(x=>x.status==='running').map(x=>'拆分 '+x.label);if(r.length)process.stdout.write(r.join(' '))}catch(e){}})" 2>/dev/null || true)"
  [ -z "$JOBS" ] || BUSY="${BUSY:+$BUSY }$JOBS"
  [ -z "$BUSY" ] || die "端口 $PORT 上还有活在跑（$BUSY）。等它跑完再更新；确认现在重启就加 --force。"
}
[ "$CHECK_ONLY" = 1 ] || assert_no_live_runs

# ---------- 1.6 检查：类型 / 单测 / 冒烟（隔离数据目录，不碰正在跑的服务） ----------
run_checks() {
  [ "$DO_CHECK" = 1 ] || return 0
  command -v npm >/dev/null 2>&1 || die "找不到 npm"
  info "类型检查（npm run typecheck）"
  npm run typecheck || die "类型检查失败，当前服务未动"
  if [ "$NODE_MAJOR" -ge 24 ]; then
    info "单元测试（npm test）"
    npm test || die "单元测试失败，当前服务未动"
  else
    info "跳过 npm test（Node $NODE_VER；TS 测试需要 Node 24）"
  fi
  SMOKE_DATA="$(mktemp -d)"
  SMOKE_PORT_NUM="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
  info "冒烟检查（隔离数据目录 + 临时端口 $SMOKE_PORT_NUM）"
  RC=0
  ( LOSFLOW_DATA="$SMOKE_DATA" LOSFLOW_TEMP="$SMOKE_DATA/tmp" LOSFLOW_STREAMS="$SMOKE_DATA/streams" LOSFLOW_RUNSTATE="$SMOKE_DATA/runstate" SMOKE_PORT="$SMOKE_PORT_NUM" npm run smoke ) || RC=$?
  rm -rf "$SMOKE_DATA"
  [ "$RC" -eq 0 ] || die "冒烟检查失败，当前服务未动"
}
run_checks

if [ "$CHECK_ONLY" = 1 ]; then
  echo "✓ 构建 / 检查通过（--check-only：没有重启服务）"
  exit 0
fi

# ---------- 2. 找到端口占用者：是驾驶舱就停掉，不是就拒绝 ----------
# 检查期间可能又有新任务开跑：落刀前再确认一次。
assert_no_live_runs
PIDS="$(find_pids || true)"
if [ -n "$PIDS" ]; then
  for pid in $PIDS; do
    cmd="$(proc_cmdline "$pid")"
    case "$cmd" in
      *server.mjs*)
        info "停止端口 $PORT 上的旧服务 PID $pid：$cmd"
        kill_pid "$pid"
        ;;
      *)
        if [ "$FORCE" = 1 ]; then
          info "强制停止端口 $PORT 上的进程 PID $pid：${cmd:-（读不到命令行）}"
          kill_pid "$pid"
        else
          die "端口 $PORT 被非驾驶舱进程占用：PID $pid ${cmd:-（读不到命令行）}
   确认可以停它再加 --force，或换 --port 另一个端口。"
        fi
        ;;
    esac
  done

  for _ in $(seq 1 20); do
    [ -z "$(find_pids | tr -d '[:space:]')" ] && break
    sleep 0.25
  done
  [ -z "$(find_pids | tr -d '[:space:]')" ] || die "端口 $PORT 仍被占用，停不掉"
fi

# ---------- 3. 用本仓库的服务启动（用绝对路径，方便事后核对监听者是谁） ----------
mkdir -p .tmp
NODE_BIN="$(node -p "process.execPath")"
out_log="$ROOT/.tmp/dashboard-$PORT.out.log"
err_log="$ROOT/.tmp/dashboard-$PORT.err.log"
if [ "$PLATFORM" = win ]; then
  SRV_JS="$(winpath "$ROOT/server/server.mjs")"
else
  SRV_JS="$ROOT/server/server.mjs"
fi

if [ "$PLATFORM" = win ]; then
  # 不抓 PowerShell 的 stdout：Start-Process 起的进程可能继承管道导致脚本挂住。
  # PID 以「端口上真实监听者」为准，后面统一核对。
  ps_cmd="\$p = Start-Process -FilePath '$NODE_BIN' -ArgumentList @('$SRV_JS','$PORT') -WorkingDirectory '$(winpath "$ROOT")' -WindowStyle Hidden -RedirectStandardOutput '$(winpath "$out_log")' -RedirectStandardError '$(winpath "$err_log")' -PassThru; \$p.Id | Out-Null"
  powershell -NoProfile -Command "$ps_cmd" >/dev/null 2>&1 || die "启动服务失败，看 $err_log"
else
  nohup "$NODE_BIN" "$SRV_JS" "$PORT" > "$out_log" 2>&1 &
fi

# ---------- 4. 健康检查：接口能响应 ----------
OK=0
for _ in $(seq 1 80); do
  if curl -sf --max-time 3 "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1; then OK=1; break; fi
  sleep 0.25
done
if [ "$OK" != 1 ]; then
  echo "✗ 新服务没有响应 http://127.0.0.1:$PORT/api/state" >&2
  tail -20 "$err_log" 2>/dev/null >&2
  exit 1
fi

# ---------- 5. 校验：监听者就是本仓库的 server.mjs ----------
START_PID="$(find_pids | head -1 | tr -d '[:space:]')"
[ -n "$START_PID" ] || die "端口 $PORT 没有监听进程，看 $err_log"
LISTEN_CMD="$(proc_cmdline "$START_PID")"
case "$LISTEN_CMD" in
  *"$SRV_JS"*) : ;;
  *)
    die "端口 $PORT 的监听进程不是本仓库的服务（PID $START_PID：${LISTEN_CMD:-读不到命令行}）。
   可能被别的服务抢占了，或启动后立刻退出。看 $err_log"
    ;;
esac
echo "$START_PID" > ".tmp/dashboard-$PORT.pid"

# ---------- 6. 校验：端口上响应的前端产物就是 web/dist 这一份 ----------
ACTUAL="$(curl -s --max-time 5 "http://127.0.0.1:$PORT/app/" | grep -o 'assets/index-[^"]*\.js' | head -1 || true)"
if [ "$ACTUAL" != "$EXPECT" ]; then
  echo "✗ 端口 $PORT 上响应的前端产物与本仓库不一致：" >&2
  echo "   期望：$EXPECT" >&2
  echo "   实际：${ACTUAL:-（没取到）}" >&2
  echo "   → 可能还有别的服务在响应。看 $err_log" >&2
  tail -20 "$err_log" 2>/dev/null >&2
  exit 1
fi

# ---------- 完成 ----------
REV="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
DIRTY=""
if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then DIRTY="（工作区有未提交改动）"; fi

echo "✓ 前端已构建：$EXPECT"
echo "✓ 服务已接管：PID $START_PID · 端口 $PORT · 提交 $REV$DIRTY"
echo "  驾驶舱：http://127.0.0.1:$PORT/app/"
echo "  日志：  .tmp/dashboard-$PORT.out.log / .tmp/dashboard-$PORT.err.log"
echo "  面板里如果还显示旧界面，刷新一下（Ctrl+F5）。"
