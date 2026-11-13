@echo off
rem =====================================================================
rem update.bat -- rebuild the frontend, take over the dashboard port with
rem THIS repo server, and verify the takeover actually happened.
rem
rem Same behavior as update.sh; native Windows entry point, no Git Bash
rem or WSL needed.
rem
rem This bat is just an entry point: the real logic lives after the
rem ::PS-BODY-START marker below and is executed by PowerShell, which
rem reads this file as UTF-8 (avoids cmd code page issues).
rem
rem IMPORTANT: keep everything before ::PS-BODY-START ASCII-only. cmd
rem mis-parses UTF-8 rem lines on a GBK (936) console and can swallow the
rem beginning of the following line, executing garbage.
rem
rem Why it exists:
rem   A stale checkout keeps holding the dashboard port, so the DSH panel
rem   iframe serves the old frontend/API. This script finds the real
rem   listener, replaces it with this repo server.mjs, then verifies:
rem     1) the PID listening on the port is the process it just started;
rem     2) /app/ serves the same frontend bundle as web/dist.
rem   If either check fails it exits with an error instead of pretending
rem   the update worked.
rem
rem Usage:
rem   update.bat               build + restart (default)
rem   update.bat --no-build    restart only, no build
rem   update.bat --port 8900   use another port (default LOSFLOW_PORT /
rem                            losflow.config.json / 8899)
rem   update.bat --force       also kill a non-server.mjs process holding
rem                            the port (refused by default)
rem   update.bat -h            help
rem
rem Note: builds the current working tree; does not git pull.
rem =====================================================================
setlocal EnableExtensions
set "LOSFLOW_SELF=%~f0"
set "LOSFLOW_ROOT=%~dp0"
set "LOSFLOW_ARGS=%*"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:LOSFLOW_SELF,[Text.Encoding]::UTF8); $k='::PS-BODY-START'; Invoke-Expression $t.Substring($t.LastIndexOf($k) + $k.Length)"
exit /b %errorlevel%
::PS-BODY-START
# ==================== 以下由 PowerShell 执行 ====================
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

function Out-Line([string]$m) { [Console]::Out.WriteLine($m) }
function Out-Err([string]$m) { [Console]::Error.WriteLine($m) }
function Die([string]$m) { [Console]::Error.WriteLine("[X] $m"); exit 1 }
function Info([string]$m) { [Console]::Out.WriteLine("-> $m") }
function Show-Help {
  Out-Line 'update.bat -- 重建前端 + 用本仓库的服务接管驾驶舱端口，并验证接管成功。'
  Out-Line ''
  Out-Line '用法：'
  Out-Line '  update.bat               构建 + 重启（默认）'
  Out-Line '  update.bat --no-build    只重启，不构建'
  Out-Line '  update.bat --port 8900   指定端口（默认 LOSFLOW_PORT / losflow.config.json / 8899）'
  Out-Line '  update.bat --force       端口被非 server.mjs 进程占用时也强杀（默认拒绝）'
  Out-Line '  update.bat -h            帮助'
}

# ---------- 0. 参数 ----------
$argv = @()
if ($env:LOSFLOW_ARGS) {
  $argv = @($env:LOSFLOW_ARGS -split '\s+' | Where-Object { $_ } | ForEach-Object { $_.Trim('"').Trim("'") })
}
$doBuild = $true
$force = $false
$portArg = $null
for ($i = 0; $i -lt $argv.Count; $i++) {
  switch ($argv[$i]) {
    '--no-build' { $doBuild = $false }
    '--force'    { $force = $true }
    '--port'     {
      $i++
      if ($i -ge $argv.Count) { Die '--port 后面要跟端口号' }
      $portArg = $argv[$i]
    }
    '-h'      { Show-Help; exit 0 }
    '--help'  { Show-Help; exit 0 }
    '/?'      { Show-Help; exit 0 }
    default   { Die "不认识的参数：$($argv[$i])，用 --help 看用法" }
  }
}

$root = $env:LOSFLOW_ROOT
if (-not $root) { Die '拿不到脚本所在目录' }
Set-Location -LiteralPath $root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die '找不到 node（需要 Node >= 20）' }

# ---------- 端口：参数 > LOSFLOW_PORT > losflow.config.json > 8899 ----------
$port = $null
if ($portArg) { $port = $portArg }
elseif ($env:LOSFLOW_PORT) { $port = $env:LOSFLOW_PORT }
else {
  $cfg = Join-Path $root 'losflow.config.json'
  if (Test-Path -LiteralPath $cfg) {
    try { $port = (Get-Content -LiteralPath $cfg -Raw | ConvertFrom-Json).dashboardPort } catch { }
  }
}
if (-not $port) { $port = 8899 }
if ("$port" -notmatch '^\d+$') { Die "端口不合法：$port" }

# ---------- 1. 先构建：构建失败就不动正在跑的服务 ----------
if ($doBuild) {
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Die '找不到 npm' }
  if (-not (Test-Path -LiteralPath (Join-Path $root 'web\node_modules'))) {
    Info '首次构建：安装 web 依赖'
    & npm --prefix web install
    if ($LASTEXITCODE -ne 0) { Die 'web 依赖安装失败' }
  }
  Info '构建前端（web/dist）'
  & npm run build
  if ($LASTEXITCODE -ne 0) { Die '前端构建失败，当前服务未动' }
}

$distIndex = Join-Path $root 'web\dist\index.html'
if (-not (Test-Path -LiteralPath $distIndex)) { Die 'web\dist\index.html 不存在，先跑一次构建' }
$expect = [regex]::Match((Get-Content -LiteralPath $distIndex -Raw), 'assets/index-[A-Za-z0-9_-]+\.js').Value
if (-not $expect) { Die 'web/dist/index.html 里找不到前端产物，构建可能不完整' }

function Get-ListenPids([int]$port) {
  $res = netstat -ano | ForEach-Object {
    $f = $_.Trim() -split '\s+'
    if ($f.Length -ge 5 -and $f[0] -eq 'TCP' -and $f[3] -eq 'LISTENING' -and $f[1].EndsWith(':' + $port)) { $f[4] }
  }
  @($res | Sort-Object -Unique)
}
function Get-CmdLine($procId) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
  if ($p) { $p.CommandLine } else { '' }
}

$tmp = Join-Path $root '.tmp'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$srvJs = Join-Path $root 'server\server.mjs'
# 日志 / pid 按端口区分：同一个 .tmp 里可能同时跑多个驾驶舱（--port 8900 之类），
# 共用一份日志会互相锁文件，后来启动的那个 cmd 会直接退出（退出码 1）。
$outLog = Join-Path $tmp "dashboard-$port.out.log"
$errLog = Join-Path $tmp "dashboard-$port.err.log"
$pidFile = Join-Path $tmp "dashboard-$port.pid"

# ---------- 2. 找到端口占用者：是驾驶舱就停掉，不是就拒绝 ----------
$pids = @(Get-ListenPids $port)
foreach ($p in $pids) {
  $cmd = Get-CmdLine $p
  $shown = if ($cmd) { $cmd } else { '（读不到命令行）' }
  if ($cmd -like '*server.mjs*') {
    Info "停止端口 $port 上的旧服务 PID $p：$cmd"
    Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
  }
  elseif ($force) {
    Info "强制停止端口 $port 上的进程 PID $p：$shown"
    Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
  }
  else {
    Die "端口 $port 被非驾驶舱进程占用：PID $p $shown`n   确认可以停它再加 --force，或换 --port 另一个端口。"
  }
}
if ($pids.Count -gt 0) {
  $free = $false
  for ($k = 0; $k -lt 20; $k++) {
    if (@(Get-ListenPids $port).Count -eq 0) { $free = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $free) { Die "端口 $port 仍被占用，停不掉" }
}

# ---------- 3. 用本仓库的服务启动（绝对路径，方便事后核对监听者是谁） ----------
# 用 ShellExecute（UseShellExecute=true）+ 隐藏窗口起 cmd：
#   1) 服务拿到自己的隐藏控制台，不挂在调用方的控制台上 —— 双击运行时脚本退出后
#      不会留下一个被常驻服务撑着的黑框；
#   2) ShellExecute 不继承调用方的句柄，输出被管道捕获时（脚本 / CI / agent）
#      也不会因为服务进程攥着 stdout 管道，让父进程永远等不到 EOF（之前会挂住）。
#      输出/输入重定向都在 cmd 内部完成，子进程句柄指向文件 / nul。
$nodeBin = (Get-Command node).Source
Info "启动 $srvJs $port"
$inner = '""' + $nodeBin + '" "' + $srvJs + '" ' + $port + ' > "' + $outLog + '" 2> "' + $errLog + '" < nul"'
try {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'cmd.exe'
  $psi.Arguments = '/c ' + $inner
  $psi.WorkingDirectory = $root
  $psi.UseShellExecute = $true
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $proc = [System.Diagnostics.Process]::Start($psi)
}
catch {
  Die "启动服务失败，看 $errLog（$($_.Exception.Message)）"
}

# ---------- 4. 健康检查：接口能响应 ----------
function Test-PortOpen([int]$p) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $p); return $true } catch { return $false } finally { $c.Close() }
}
function Show-ErrTail {
  if (Test-Path -LiteralPath $errLog) { Get-Content -LiteralPath $errLog -Tail 20 | ForEach-Object { Out-Err $_ } }
}
$ok = $false
$sw = [System.Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt 40) {
  # 启动后立刻退出（端口被占、日志被锁、node 崩了）就别再傻等 40 秒
  if ($proc.HasExited) {
    Out-Err "[X] 服务启动后立刻退出（退出码 $($proc.ExitCode)），看 $errLog"
    Show-ErrTail
    exit 1
  }
  if (Test-PortOpen $port) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/state" -TimeoutSec 3 -ErrorAction Stop
      if ($r.StatusCode -eq 200) { $ok = $true; break }
    }
    catch { }
  }
  Start-Sleep -Milliseconds 200
}
if (-not $ok) {
  Out-Err "[X] 新服务没有响应 http://127.0.0.1:$port/api/state"
  Show-ErrTail
  exit 1
}

# ---------- 5. 校验：监听者就是本仓库的 server.mjs ----------
$live = @(Get-ListenPids $port)
if ($live.Count -eq 0) { Die "端口 $port 没有监听进程，看 $errLog" }
$listenPid = $live[0]
$listenCmd = Get-CmdLine $listenPid
if (-not $listenCmd -or -not ($listenCmd -like "*$srvJs*")) {
  Die "端口 $port 的监听进程不是本仓库的服务（PID $listenPid：$listenCmd）`n   可能被别的服务抢占了，或启动后立刻退出。看 $errLog"
}
Set-Content -LiteralPath $pidFile -Value $listenPid -NoNewline

# ---------- 6. 校验：端口上响应的前端产物就是 web/dist 这一份 ----------
$actual = ''
try {
  $appHtml = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/app/" -TimeoutSec 5 -ErrorAction Stop).Content
  $actual = [regex]::Match($appHtml, 'assets/index-[A-Za-z0-9_-]+\.js').Value
}
catch { }
if ($actual -ne $expect) {
  Out-Err "[X] 端口 $port 上响应的前端产物与本仓库不一致："
  Out-Err "   期望：$expect"
  if ($actual) { Out-Err "   实际：$actual" } else { Out-Err '   实际：（没取到）' }
  Out-Err "   -> 可能还有别的服务在响应。看 $errLog"
  if (Test-Path -LiteralPath $errLog) { Get-Content -LiteralPath $errLog -Tail 20 | ForEach-Object { Out-Err $_ } }
  exit 1
}

# ---------- 完成 ----------
$rev = '?'
$dirty = ''
try {
  $gitOut = & git rev-parse --short HEAD 2>$null
  if ($LASTEXITCODE -eq 0 -and $gitOut) { $rev = "$gitOut".Trim() }
  $gitStat = @(& git status --porcelain 2>$null)
  if ($LASTEXITCODE -eq 0 -and $gitStat.Count -gt 0) { $dirty = '（工作区有未提交改动）' }
}
catch { }

Out-Line "✓ 前端已构建：$expect"
Out-Line "✓ 服务已接管：PID $listenPid · 端口 $port · 提交 $rev$dirty"
Out-Line "  驾驶舱：http://127.0.0.1:$port/app/"
Out-Line "  日志：  .tmp\dashboard-$port.out.log / .tmp\dashboard-$port.err.log"
Out-Line '  面板里如果还显示旧界面，刷新一下（Ctrl+F5）。'
exit 0
