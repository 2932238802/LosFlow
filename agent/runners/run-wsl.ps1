# run-wsl.ps1 -- execute one dispatch inside WSL2 (start_claude_code_jz).
# ASCII only: Windows PowerShell 5.1 parses .ps1 as ANSI unless the file has a UTF-8 BOM.
#
# Called by claude-dispatch.ps1 (the orchestrator). Returns a runner result object:
#   { rc, jsonPath, errPath, streamPath, pid, env, claudeVersion, startedAt, preflightError }
# When preflightError is non-empty the orchestrator writes NO ledger row / approvals.
param(
    [Parameter(Mandatory = $true)][string]$Id,
    [string]$Task = '',
    [string]$TaskFile = '',
    [string]$Repo = '',
    [string]$Mode = 'read',
    [string]$Allow = '',
    [string]$Resume = '',
    [string]$Model = '',
    [switch]$Mcp,
    [int]$TimeoutSec = 600,
    [double]$MaxBudget = 0,
    [switch]$Stream,
    [string]$OutDir = '',
    [string]$Distro = '',
    [string]$TaskId = '',
    $Config = $null,
    [switch]$LiveApprove,
    [int]$ApprovalTimeoutSec = 50
)

. (Join-Path $PSScriptRoot '_common.ps1')

$res = New-DsRunnerResult
$res.env = 'wsl'

function Fail-Preflight([string]$msg) {
    $res.preflightError = $msg
    return $res
}

# Windows path in a WSL dispatch: fail before spending anything.
if ($Repo -match '^[A-Za-z]:[\\/]' -or $Repo.StartsWith('\\')) {
    return Fail-Preflight ("env=wsl but repo is a Windows path: {0} (path/env mismatch)" -f $Repo)
}

$outWsl = "/tmp/cc-$Id.json"
$errWsl = "/tmp/cc-$Id.err"
$streamWsl = "/tmp/cc-$Id.stream.jsonl"
$pidWsl = "/tmp/cc-$Id.pid"

# ~ is not expanded inside quotes: swap the leading ~/ for $HOME/ and use double quotes.
$repoBash = $Repo
if ($repoBash.StartsWith('~/')) { $repoBash = '$HOME/' + $repoBash.Substring(2) }
$repoEsc = $repoBash.Replace('"', '\"')

# ---------- preflight: share reachable + distro alive ----------
$uncDir = "\\wsl.localhost\$Distro\tmp"
if (-not (Test-Path $uncDir)) {
    return Fail-Preflight ("wsl share unreachable: {0} (wrong distro name? / WSL not running)" -f $uncDir)
}

$preLines = @(
    '#!/bin/bash',
    "cd `"$repoEsc`" 2>/dev/null || exit 90",
    '[ -x /usr/bin/start_claude_code_jz ] || exit 91'
)
if ($LiveApprove) {
    $preLines += ('[ -f "{0}" ] || exit 92' -f (ConvertTo-DsWslPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'approval-mcp.py')))
    $preLines += 'command -v python3 >/dev/null 2>&1 || exit 93'
}
$preLines += 'exit 0'
$preSh = $preLines -join "`n"

$preLocal = Join-Path $uncDir "cc-$Id.pre.sh"
$preWsl = "/tmp/cc-$Id.pre.sh"
try {
    [System.IO.File]::WriteAllText($preLocal, $preSh, (New-Object System.Text.UTF8Encoding($false)))
} catch {
    return Fail-Preflight ("wsl share not writable: {0} ({1})" -f $uncDir, $_.Exception.Message)
}

$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'
$preOut = & wsl.exe -d $Distro -- bash $preWsl 2>&1 | Out-String
$preRc = $LASTEXITCODE
$ErrorActionPreference = $prevEap
try { Remove-Item $preLocal -Force } catch { }

if ($preRc -eq 90) {
    return Fail-Preflight ("repo not found in wsl: {0} (env=wsl, path/env mismatch?)" -f $Repo)
}
if ($preRc -eq 91) {
    return Fail-Preflight ("claude launcher not found in wsl: /usr/bin/start_claude_code_jz")
}
if ($preRc -eq 92 -and $LiveApprove) {
    return Fail-Preflight ("approval-mcp.py not reachable from wsl: {0}" -f (ConvertTo-DsWslPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'approval-mcp.py')))
}
if ($preRc -eq 93 -and $LiveApprove) {
    return Fail-Preflight ("python3 not found in wsl (required by live approval; use liveApprove=false to disable)")
}
if ($preRc -ne 0) {
    $detail = ("$preOut").Trim()
    if (-not $detail) { $detail = "exit $preRc" }
    return Fail-Preflight ("wsl distro not reachable: {0} ({1})" -f $Distro, $detail.Substring(0, [Math]::Min(200, $detail.Length)))
}

# ---------- build the bash script ----------
# The task body goes into a bash single-quoted string; only ' needs escaping.
$taskEsc = $Task.Replace("'", "'\''")
$allowEsc = $Allow.Replace("'", "'\''")
$resumeArg = ''
if ($Resume) { $resumeArg = "--resume '$($Resume.Replace("'", "'\''"))'" }
$modelArg = ''
if ($Model) { $modelArg = "--model '$($Model.Replace("'", "'\''"))'" }
$mcpArg = ''
if (-not $Mcp) { $mcpArg = '--strict-mcp-config' }

# Live approval: our MCP server must be loaded even when -Mcp is off (strict only keeps
# --mcp-config servers). The config file lives in WSL /tmp, same share as the run script.
$liveArg = ''
if ($LiveApprove) {
    $mcpFileWsl = "/tmp/cc-$Id.mcp.json"
    $mcpArg = ($mcpArg + " --mcp-config '$mcpFileWsl'").Trim()
    $liveArg = "--permission-prompt-tool 'mcp__losflow-approval__approval_prompt' --permission-prompts host"
    $scriptWsl = ConvertTo-DsWslPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'approval-mcp.py')
    $mcpObj = [ordered]@{
        mcpServers = [ordered]@{
            'losflow-approval' = [ordered]@{
                command = 'python3'
                args    = @($scriptWsl)
                env     = [ordered]@{
                    LOSFLOW_DATA             = (ConvertTo-DsWslPath $OutDir)
                    LOSFLOW_LIVE_RUN         = $Id
                    LOSFLOW_LIVE_TASK        = $TaskId
                    LOSFLOW_LIVE_REPO        = $Repo
                    LOSFLOW_APPROVAL_TIMEOUT = [string]$ApprovalTimeoutSec
                }
            }
        }
    }
    try {
        $mcpLocal = Join-Path $uncDir "cc-$Id.mcp.json"
        [System.IO.File]::WriteAllText($mcpLocal, (ConvertTo-Json -Depth 8 -Compress -InputObject $mcpObj), (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        return Fail-Preflight ("wsl share not writable for mcp config: {0}" -f $_.Exception.Message)
    }
}

$permArg = ''
if ($Mode -eq 'write') { $permArg = '--permission-mode acceptEdits' }

# per-call spend cap passed through to claude itself
$budgetArg = ''
if ($MaxBudget -gt 0) { $budgetArg = "--max-budget-usd $MaxBudget" }

if ($Stream) {
    $fmtArg = '--output-format stream-json --verbose'
    $target = $streamWsl
} else {
    $fmtArg = '--output-format json'
    $target = $outWsl
}

$lines = @(
    '#!/bin/bash',
    "cd `"$repoEsc`" || { echo 'REPO_NOT_FOUND' >&2; exit 90; }",
    ('timeout {0} start_claude_code_jz -p ''{1}'' --allowedTools ''{2}'' {3} {4} {5} {6} {9} {10} {11} > {7} 2> {8} &' -f `
        $TimeoutSec, $taskEsc, $allowEsc, $permArg, $resumeArg, $modelArg, $mcpArg, $target, $errWsl, $fmtArg, $budgetArg, $liveArg),
    'pid=$!',
    ('echo $pid > /tmp/cc-{0}.pid' -f $Id),
    'wait $pid',
    'rc=$?',
    'echo "RC=$rc"'
)
$shText = ($lines -join "`n") + "`n"

$shLocal = Join-Path $uncDir "cc-$Id.sh"
$shWsl = "/tmp/cc-$Id.sh"
try {
    [System.IO.File]::WriteAllText($shLocal, $shText, (New-Object System.Text.UTF8Encoding($false)))
} catch {
    return Fail-Preflight ("wsl share not writable: {0} ({1})" -f $uncDir, $_.Exception.Message)
}

# runstate: written before the run (pid stays 0 for WSL; the real pid is /tmp/cc-<id>.pid
# and terminal scanning reads it there). Node deletes this file after archiving the stream.
[void](Write-DsRunState $OutDir ([ordered]@{
            id        = $Id
            taskId    = $TaskId
            env       = 'wsl'
            repo      = $Repo
            stream    = $streamWsl
            pid       = 0
            startedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        }))

# running.json: the dashboard's "which task is running right now" (last one wins).
# Only written after preflight passed, so a failed check never looks like a live run.
try {
    $rj = [ordered]@{
        id        = $Id
        taskId    = $TaskId
        env       = 'wsl'
        status    = 'running'
        startedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        task      = $Task.Substring(0, [Math]::Min(160, $Task.Length))
        stream    = $streamWsl
    }
    [System.IO.File]::WriteAllText((Join-Path $OutDir 'running.json'), (ConvertTo-Json -Depth 4 -InputObject $rj), (New-Object System.Text.UTF8Encoding($false)))
} catch { }

$res.startedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
$res.jsonPath = if ($Stream) { Join-Path $uncDir "cc-$Id.stream.jsonl" } else { Join-Path $uncDir "cc-$Id.json" }
$res.errPath = Join-Path $uncDir "cc-$Id.err"
$res.streamPath = Join-Path $uncDir "cc-$Id.stream.jsonl"

# ---------- run ----------
$ErrorActionPreference = 'SilentlyContinue'
$runOut = & wsl.exe -d $Distro -- bash $shWsl 2>&1 | Out-String
$ErrorActionPreference = $prevEap

$rc = $null
if ($runOut -match 'RC=(\d+)') { $rc = [int]$Matches[1] }
$res.rc = $rc

# pid file may still be readable right after exit; keep it for runstate completeness
try {
    if (Test-Path (Join-Path $uncDir "cc-$Id.pid")) {
        $p = ([System.IO.File]::ReadAllText((Join-Path $uncDir "cc-$Id.pid"))).Trim()
        if ($p -match '^\d+$') { $res.pid = [int]$p }
    }
} catch { }

return $res
