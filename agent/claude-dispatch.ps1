<#
.SYNOPSIS
    Dispatch one task to Claude Code in the environment its project belongs to:
    WSL2 (start_claude_code_jz: one-api gateway + deepseek-v4-flash) or Windows
    (local claude.exe). Collect the receipt, append to a ledger. Built for cost control.

.DESCRIPTION
    Two layers:
      orchestrator (this file) -- dedupe / budget / resume / allowlist / approvals /
        receipt parsing / ledger / running.json. Environment-agnostic.
      runner (runners/run-wsl.ps1, runners/run-windows.ps1) -- execute only. They do
        their own preflight and return { rc, jsonPath, errPath, streamPath, pid, env }.
        A preflight failure writes NO ledger row, NO approval and NO running.json.

    Environments never share CLI, config, sessions, processes or temp files. A WSL
    session_id cannot be resumed on Windows and vice versa.

    Rules learned from live tests (2026-11-13):
      1. --allowedTools needs PREFIX wildcards: 'Bash(npm run typecheck:*)'. An exact entry
         fails because the model wraps commands as 'cmd 2>&1; echo "EXIT=$?"'.
      2. Redirect stderr to its own file; otherwise '[claude-code:unrecognized_model] ...'
         lands in stdout and JSON parsing dies.
      3. Resume the same session for follow-ups: new input tokens drop from ~13K to ~600.
      4. MCP server tool schemas cost ~500 tokens per call. This tool defaults to
         --strict-mcp-config (no MCP servers); pass -Mcp when the task needs context7 etc.
      5. Every extra turn re-sends the context. A 4-turn run cost ~40% more than a 2-turn
         run. Give a complete task and a correct allowlist the first time.

    Cost levers implemented here:
      - -Continue      resume the latest session for this repo (biggest saving)
      - -DedupeMinutes identical task that already succeeded recently is not re-run
      - -MaxCostUsd    refuse to start when today's spend would exceed the cap
      - --strict-mcp-config by default
      - suggested allowlist derived from denials, so the retry does not burn turns again

    NOTE: keep the body ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI unless the
    file has a UTF-8 BOM, so CJK text breaks parsing unless the BOM is preserved.

    NOTE: stdout is forced to UTF-8 (see the prologue below). When this script is started
    by the dashboard (no console / OEM code page), PS 5.1 otherwise writes GBK and the
    caller reads it as UTF-8, which turns every Chinese character into mojibake.

.PARAMETER Task
    Task body. Use the four-part form: symptom / source of truth / how to verify / reply.

.PARAMETER TaskFile
    Read the task body from a UTF-8 file instead.

.PARAMETER Repo
    Repo directory. Default depends on the resolved environment (see -Env):
    wsl -> ~/LosAngelous/Vesta, windows -> must be provided.

.PARAMETER Env
    Execution environment: auto (default), wsl or windows. Resolved from Repo when auto;
    an explicit value is authoritative but the runner still verifies the path exists there.
    Windows dispatch uses the local Claude Code; WSL dispatch uses start_claude_code_jz.
    The two never share CLI, config, sessions, processes or temp files.

.PARAMETER Mode
    read (default) or write (adds Write/Edit and --permission-mode acceptEdits).

.PARAMETER Allow
    Extra allowedTools entries, space separated, prefix wildcards.

.PARAMETER Resume
    Explicit session_id to continue.

.PARAMETER Continue
    Resume the most recent session that ran against this repo.

.PARAMETER Model
    Pass --model. Empty means whatever the launcher sets (deepseek-v4-flash).

.PARAMETER Mcp
    Keep MCP servers from settings (costs ~500 tokens). Default is to skip them.

.PARAMETER MaxCostUsd
    Per-day spend cap for this tool. Default 2.00. Refuses to start when exceeded.

.PARAMETER DedupeMinutes
    Skip an identical task that already succeeded within this window. Default 30. 0 disables.

.PARAMETER Force
    Ignore dedupe and the spend cap.

.PARAMETER DryRun
    Print the bash script and the computed plan; execute nothing.

.EXAMPLE
    .\claude-dispatch.ps1 -Task 'Run npm run typecheck. Report exit code and error count. Do not edit.' -Allow 'Bash(npm run typecheck:*)'

.EXAMPLE
    .\claude-dispatch.ps1 -Continue -Task 'Review your own change: what did you edit, what did you verify, what failed.'

.EXAMPLE
    .\claude-dispatch.ps1 -Mode write -Allow 'Bash(npm run *:*)' -TaskFile D:\PROJECT\Ds\_progress\task.md
#>
[CmdletBinding()]
param(
    [string]$Task,
    [string]$TaskFile,
    [string]$Repo = '',
    [ValidateSet('read', 'write')]
    [string]$Mode = 'read',
    [string]$Allow = '',
    [string]$Resume = '',
    [switch]$Continue,
    [string]$Model = '',
    [switch]$Mcp,
    [double]$MaxCostUsd = 2.00,
    [int]$DedupeMinutes = 30,
    [switch]$Force,
    [switch]$DryRun,
    [ValidateSet('auto', 'wsl', 'windows', '')]
    [string]$Env = 'auto',
    [string]$Distro = '',
    [int]$TimeoutSec = 600,
    [string]$OutDir = '',
    [double]$MaxBudget = 0,
    [string]$TaskId = '',
    [switch]$Stream,
    [switch]$JsonOut,
    [switch]$NoApproval,
    [switch]$NoLiveApprove,
    [int]$ApprovalTimeoutSec = 0
)

# ---------- paths ----------
# 仪表盘调用时不带 -OutDir / -Distro / -Repo，必须在这里补默认值；
# 否则 Join-Path '' 'runs' 会直接抛 "Path 为空字符串"，脚本 1 秒退出、没有回执。
. (Join-Path $PSScriptRoot '_paths.ps1')
$cfg = Get-DsPaths
if (-not $OutDir) { $OutDir = $cfg.progressDir }
if (-not $Distro) { $Distro = $cfg.wslDistro }
if (-not $PSBoundParameters.ContainsKey('TimeoutSec')) { $TimeoutSec = [int]$cfg.claudeTimeoutSec }

# Live approval: --permission-prompt-tool -> agent/approval-mcp.py.
# Default on; losflow.config.json { "liveApprove": false } or -NoLiveApprove falls back to
# "run first, ask afterwards" (legacy approvals + retry).
$liveApprove = $true
if ($cfg.PSObject.Properties.Name -contains 'liveApprove' -and $cfg.liveApprove -eq $false) { $liveApprove = $false }
if ($NoLiveApprove) { $liveApprove = $false }
if ($ApprovalTimeoutSec -le 0) {
    $ApprovalTimeoutSec = 50
    if ($cfg.PSObject.Properties.Name -contains 'approvalTimeoutSec' -and [int]$cfg.approvalTimeoutSec -gt 0) {
        $ApprovalTimeoutSec = [int]$cfg.approvalTimeoutSec
    }
}
$ApprovalTimeoutSec = [Math]::Max(5, [Math]::Min(55, $ApprovalTimeoutSec))

# Execution environment is a first-class field: resolve once here, then hand it to the runner.
# Rule is duplicated in server/env.mjs (must stay identical).
$defaultEnv = 'wsl'
if ($cfg.defaultEnv) { $defaultEnv = [string]$cfg.defaultEnv }
$Env = Resolve-DsEnv -Path $Repo -Explicit $Env -DefaultEnv $defaultEnv
if (-not $Repo -and $Env -eq 'wsl') { $Repo = [string]$cfg.wslRepo }

# ---------- UTF-8 stdout ----------
# Without this, the same script writes GBK when launched from a service/console-less parent
# and the caller (Node) reads the JSON as UTF-8 -> every CJK char becomes U+FFFD.
try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $utf8NoBom
    $OutputEncoding = $utf8NoBom
} catch { }

$ErrorActionPreference = 'Stop'

if (-not $Task -and -not $TaskFile) { throw 'Need -Task or -TaskFile' }
if ($TaskFile) { $Task = [System.IO.File]::ReadAllText($TaskFile, [System.Text.Encoding]::UTF8) }
if (-not $Task.Trim()) { throw 'Task body is empty' }

$runsDir = Join-Path $OutDir 'runs'
if (-not (Test-Path $runsDir)) { New-Item -ItemType Directory -Path $runsDir -Force | Out-Null }
$ledger = Join-Path $OutDir 'claude-ledger.jsonl'
$progressDir = $OutDir
if (-not (Test-Path $progressDir)) { New-Item -ItemType Directory -Path $progressDir -Force | Out-Null }
$runningFile = Join-Path $progressDir 'running.json'
$approvalsFile = Join-Path $progressDir 'approvals.json'
$allowFile = Join-Path $progressDir 'allowlist.json'

# ---------- helpers ----------
function Get-LedgerRows {
    if (-not (Test-Path $ledger)) { return @() }
    $rows = @()
    foreach ($l in [System.IO.File]::ReadAllLines($ledger, [System.Text.Encoding]::UTF8)) {
        if (-not $l.Trim()) { continue }
        try { $rows += ($l | ConvertFrom-Json) } catch { }
    }
    return $rows
}
function Get-TaskHash([string]$s) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($s)
    $hex = ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join ''
    $sha.Dispose()
    return $hex.Substring(0, 12)
}
function Read-JsonFile([string]$p, $fallback) {
    if (-not (Test-Path $p)) { return $fallback }
    try { return ([System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) | ConvertFrom-Json) } catch { return $fallback }
}
function Write-JsonFile([string]$p, $v) {
    [System.IO.File]::WriteAllText($p, (ConvertTo-Json -Depth 6 -InputObject $v), (New-Object System.Text.UTF8Encoding($false)))
}
function Remove-Running {
    try { if (Test-Path $runningFile) { Remove-Item $runningFile -Force } } catch { }
}

$id = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + ([guid]::NewGuid().ToString('N').Substring(0, 6))

# Preflight failure: nothing was spent, so write NO ledger row, NO approval, NO running.json.
# The receipt still has the same shape so the dashboard / caller can show the reason.
function Write-Preflight([string]$msg) {
    Write-Host ("PREFLIGHT: {0}" -f $msg) -ForegroundColor Red
    $out = [pscustomobject]@{
        id              = $id
        status          = 'preflight'
        rc              = 90
        env             = $Env
        session_id      = ''
        resumed         = $false
        is_error        = $false
        turns           = $null
        duration_s      = 0
        cost_usd        = $null
        input_tok       = $null
        cache_read      = $null
        denials         = ''
        suggested_allow = ''
        result          = ''
        json            = ''
        ledger          = $ledger
        elapsed_s       = 0
        today_spend     = [math]::Round($todaySpend, 4)
        error           = $msg
        stderr          = ''
        preflight       = $true
    }
    if ($JsonOut) { Write-Output (ConvertTo-Json -Compress -Depth 4 -InputObject $out) } else { $out }
}

$rows = Get-LedgerRows
$today = (Get-Date).ToString('yyyy-MM-dd')
$todayRows = @($rows | Where-Object { $_.at -and $_.at.StartsWith($today) })
$todaySpend = 0.0
foreach ($r in $todayRows) { if ($r.cost_usd) { $todaySpend += [double]$r.cost_usd } }

# Windows dispatch always needs an explicit repo: there is no sensible default directory.
if ($Env -eq 'windows' -and -not $Repo) {
    Write-Preflight 'env=windows requires -Repo (no default Windows working directory)'
    return
}

# env is part of the hash: the same sentence in a WSL project and a Windows project are
# two different jobs and must not dedupe each other.
$taskHash = Get-TaskHash ("$Env|$Repo|$Mode|$Allow|$Task")

# ---------- dedupe ----------
if ($DedupeMinutes -gt 0 -and -not $Force) {
    $cut = (Get-Date).AddMinutes(-$DedupeMinutes)
    $prev = @($rows | Where-Object {
            $_.task_hash -eq $taskHash -and $_.status -eq 'ok' -and $_.at -and
            ([datetime]::ParseExact($_.at, 'yyyy-MM-dd HH:mm:ss', $null) -gt $cut)
        } | Select-Object -Last 1)
    if ($prev.Count -gt 0) {
        Write-Host ("SKIPPED: identical task already succeeded at {0} (id {1}, cost {2:C3}). Use -Force to run again." -f $prev[0].at, $prev[0].id, [double]$prev[0].cost_usd) -ForegroundColor Yellow
        $deduped = [pscustomobject]@{
            id              = $prev[0].id
            status          = 'deduped'
            rc              = 0
            env             = $Env
            session_id      = $prev[0].session_id
            resumed         = $false
            is_error        = $false
            turns           = $prev[0].turns
            duration_s      = $null
            cost_usd        = [double]$prev[0].cost_usd
            input_tok       = $null
            cache_read      = $null
            denials         = ''
            suggested_allow = ''
            result          = '(deduped re-run of the same task)'
            json            = $prev[0].json_run
            ledger          = $ledger
            elapsed_s       = 0
            today_spend     = [math]::Round($todaySpend, 4)
            error           = $null
            stderr          = ''
            preflight       = $false
        }
        if ($JsonOut) { Write-Output (ConvertTo-Json -Compress -Depth 4 -InputObject $deduped) } else { $deduped }
        return
    }
}

# ---------- budget ----------
if (-not $Force -and $todaySpend -ge $MaxCostUsd) {
    throw ("Daily cap reached: spent {0:C3} today, cap {1:C3}. Use -Force or raise -MaxCostUsd." -f $todaySpend, $MaxCostUsd)
}

# ---------- resume resolution ----------
# Sessions do not cross environments: a WSL session_id cannot be resumed on Windows and
# vice versa. Old ledger rows have no env field -> they are wsl.
if (-not $Resume -and $Continue) {
    $last = @($rows | Where-Object {
            $_.repo -eq $Repo -and $_.session_id -and
            (($_.env -eq $Env) -or (-not $_.env -and $Env -eq 'wsl'))
        } | Select-Object -Last 1)
    if ($last.Count -gt 0) {
        $Resume = [string]$last[0].session_id
    } else {
        $other = @($rows | Where-Object { $_.repo -eq $Repo -and $_.session_id -and $_.env -and $_.env -ne $Env } | Select-Object -Last 1)
        if ($other.Count -gt 0) {
            Write-Host ("NOTE: -Continue ignored: the last session for this repo belongs to env={0}, not env={1}. Start a new session." -f $other[0].env, $Env) -ForegroundColor Yellow
        } else {
            Write-Host 'NOTE: -Continue found no earlier session for this repo; starting a new one.' -ForegroundColor Yellow
        }
    }
}

# ---------- tool permissions ----------
if ($Mode -eq 'write') {
    $allowed = 'Write Edit Read Grep Glob'
} else {
    $allowed = 'Read Grep Glob'
}
if ($Allow) { $allowed = ($allowed + ' ' + $Allow).Trim() }

# allowlist.json: rules the human already approved in the dashboard, applied to every run
$allowRules = @(Read-JsonFile $allowFile @())
if ($allowRules.Count -gt 0) {
    $allowed = ($allowed + ' ' + ($allowRules -join ' ')).Trim()
}

# ---------- plan / dry run ----------
if ($DryRun) {
    Write-Host '--- plan ---' -ForegroundColor Cyan
    Write-Host ("env       : {0}" -f $Env)
    Write-Host ("repo      : {0}" -f $Repo)
    Write-Host ("mode      : {0}   tools: {1}" -f $Mode, $allowed)
    Write-Host ("resume    : {0}" -f ($(if ($Resume) { $Resume } else { '(new session)' })))
    Write-Host ("mcp       : {0}" -f ($(if ($Mcp) { 'kept' } else { 'skipped (--strict-mcp-config)' })))
    Write-Host ("approve   : {0}   timeout: {1}s" -f ($(if ($liveApprove) { 'live (permission-prompt-tool)' } else { 'legacy (after run)' })), $ApprovalTimeoutSec)
    Write-Host ("stream    : {0}   jsonout: {1}" -f [bool]$Stream, [bool]$JsonOut)
    Write-Host ("runner    : {0}" -f (Join-Path $PSScriptRoot ("runners\run-$Env.ps1")))
    Write-Host ("spent today: {0:C3} / cap {1:C3}" -f $todaySpend, $MaxCostUsd)
    return
}

# ---------- run (execution layer) ----------
# Orchestration above stays environment-agnostic; runners only execute and return paths/pid.
# They perform their own preflight and write running.json + runstate only after it passes.
$runner = Join-Path $PSScriptRoot ("runners\run-$Env.ps1")
if (-not (Test-Path $runner)) {
    Write-Preflight ("runner missing for env={0}: {1}" -f $Env, $runner)
    return
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$run = & $runner -Id $id -Task $Task -TaskFile $TaskFile -Repo $Repo -Mode $Mode -Allow $allowed `
    -Resume $Resume -Model $Model -Mcp:$Mcp -TimeoutSec $TimeoutSec -MaxBudget $MaxBudget `
    -Stream:$Stream -OutDir $OutDir -Distro $Distro -TaskId $TaskId -Config $cfg `
    -LiveApprove:$liveApprove -ApprovalTimeoutSec $ApprovalTimeoutSec
$sw.Stop()

if (-not $run) {
    Write-Preflight ("runner returned nothing (env={0})" -f $Env)
    return
}
if ($run.preflightError) {
    Remove-Running
    Write-Preflight ([string]$run.preflightError)
    return
}

$rc = $run.rc

# ---------- parse receipt ----------
$jsonPath = $run.jsonPath
$errPath = $run.errPath
$receipt = $null
$parseErr = $null
if (Test-Path $jsonPath) {
    $raw = [System.IO.File]::ReadAllText($jsonPath, [System.Text.Encoding]::UTF8)
    $line = ($raw -split "`n" | Where-Object { $_.TrimStart().StartsWith('{') } | Select-Object -Last 1)
    if ($line) {
        try { $receipt = $line | ConvertFrom-Json } catch { $parseErr = $_.Exception.Message }
    } else { $parseErr = 'No JSON line found in output' }
} else { $parseErr = 'No json file produced' }

$errText = ''
if (Test-Path $errPath) { $errText = ([System.IO.File]::ReadAllText($errPath, [System.Text.Encoding]::UTF8)).Trim() }

$denials = @()
$deniedCmds = @()
if ($receipt -and $receipt.permission_denials) {
    foreach ($d in $receipt.permission_denials) {
        $denials += $d.tool_name
        if ($d.tool_input -and $d.tool_input.command) { $deniedCmds += [string]$d.tool_input.command }
    }
}

# Turn denials into allowlist suggestions so the retry does not burn turns again.
$suggested = @()
foreach ($c in $deniedCmds) {
    $first = ($c -split '\s+')[0]
    $second = ($c -split '\s+')[1]
    if ($first -eq 'Bash' -or -not $second) { continue }
    $suggested += ("Bash({0} {1}:*)" -f $first, $second)
}
$suggested = @($suggested | Select-Object -Unique)

$status = 'unknown'
if ($rc -eq 124) { $status = 'timeout' }
elseif ($parseErr) { $status = 'unparsed' }
elseif ($receipt -and $receipt.is_error) { $status = 'error' }
elseif ($denials.Count -gt 0) { $status = 'denied' }
elseif ($receipt -and ($receipt.subtype -eq 'success' -or $receipt.type -eq 'result')) { $status = 'ok' }

$resultText = ''
if ($receipt -and $receipt.result) { $resultText = [string]$receipt.result }
$sessionId = ''
if ($receipt -and $receipt.session_id) { $sessionId = [string]$receipt.session_id }

# ---------- persist ----------
if (Test-Path $jsonPath) { Copy-Item $jsonPath (Join-Path $runsDir "$id.json") -Force }

$entry = [ordered]@{
    id              = $id
    at              = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    task_id         = $TaskId
    task_hash       = $taskHash
    env             = $Env
    repo            = $Repo
    mode            = $Mode
    resumed_from    = $Resume
    session_id      = $sessionId
    status          = $status
    rc              = $rc
    timeout_sec     = $TimeoutSec
    model           = $Model
    mcp             = [bool]$Mcp
    claude_version  = $run.claudeVersion
    stream          = $run.streamPath
    billing         = if ($receipt -and $null -ne $receipt.total_cost_usd) { 'gateway' } else { 'unknown' }
    is_error        = if ($receipt) { [bool]$receipt.is_error } else { $null }
    subtype         = if ($receipt) { $receipt.subtype } else { $null }
    turns           = if ($receipt) { $receipt.num_turns } else { $null }
    duration_ms     = if ($receipt) { $receipt.duration_ms } else { $null }
    cost_usd        = if ($receipt) { $receipt.total_cost_usd } else { $null }
    input_tokens    = if ($receipt) { $receipt.usage.input_tokens } else { $null }
    cache_read      = if ($receipt) { $receipt.usage.cache_read_input_tokens } else { $null }
    denials         = @($denials)
    denied_cmds     = @($deniedCmds)
    suggested_allow = @($suggested)
    allowed_tools   = $allowed
    task_preview    = $Task.Substring(0, [Math]::Min(200, $Task.Length))
    result_preview  = $resultText.Substring(0, [Math]::Min(400, $resultText.Length))
    result_len      = $resultText.Length
    json_run        = (Join-Path $runsDir "$id.json")
    stderr          = $errText.Substring(0, [Math]::Min(300, $errText.Length))
}
[System.IO.File]::AppendAllText($ledger, (($entry | ConvertTo-Json -Compress -Depth 6) + "`n"), (New-Object System.Text.UTF8Encoding($false)))

# ---------- approval queue ----------
# Denied runs become a pending approval the human can click in the dashboard; approving it
# adds the rules to allowlist.json and re-dispatches the same task exactly once.
# -NoApproval only means "run non-interactively"; it does NOT suppress the queue.
if ($denials.Count -gt 0) {
    try {
        $list = @(Read-JsonFile $approvalsFile @())
        $rec = [ordered]@{
            id        = 'ap-' + $id
            at        = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
            runId     = $id
            taskId    = $TaskId
            tool      = ($denials -join ',')
            cmd       = ($deniedCmds -join "`n")
            # 面板按 commands 数组渲染；cmd 保留完整原文给人看
            commands  = @($deniedCmds)
            suggested = @($suggested)
            task      = $Task
            mode      = $Mode
            allow     = $Allow
            repo      = $Repo
            env       = $Env
            status    = 'pending'
        }
        $list = @($list) + [pscustomobject]$rec
        [System.IO.File]::WriteAllText($approvalsFile, (ConvertTo-Json -InputObject @($list) -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

Remove-Running

$newSpend = $todaySpend
if ($entry.cost_usd) { $newSpend += [double]$entry.cost_usd }

# ---------- output ----------
$out = [pscustomobject]@{
    id              = $id
    status          = $status
    rc              = $rc
    env             = $Env
    session_id      = $sessionId
    resumed         = [bool]$Resume
    is_error        = $entry.is_error
    turns           = $entry.turns
    duration_s      = if ($entry.duration_ms) { [math]::Round($entry.duration_ms / 1000, 1) } else { $null }
    cost_usd        = $entry.cost_usd
    input_tok       = $entry.input_tokens
    cache_read      = $entry.cache_read
    denials         = ($denials -join ',')
    suggested_allow = ($suggested -join ' ')
    result          = $resultText
    json            = $entry.json_run
    ledger          = $ledger
    elapsed_s       = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    today_spend     = [math]::Round($newSpend, 4)
    error           = $parseErr
    stderr          = $errText
}

if ($JsonOut) {
    Write-Output (ConvertTo-Json -Compress -Depth 4 -InputObject $out)
} else {
    $out
}
