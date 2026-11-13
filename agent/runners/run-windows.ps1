# run-windows.ps1 -- execute one dispatch with the local Windows Claude Code.
# ASCII only: Windows PowerShell 5.1 parses .ps1 as ANSI unless the file has a UTF-8 BOM.
#
# Called by claude-dispatch.ps1 (the orchestrator). Returns the same runner result object
# as run-wsl.ps1. Nothing here touches WSL: own exe, own env, own state files.
#
# Notes learned from the 7th design doc:
#   - call the real .exe, never claude-jz.ps1 (it opens folder pickers and Read-Host)
#   - task body goes in through stdin, never through the command line
#   - strict MSVC quoting for the argument string (Start-Process joins with spaces)
#   - stdout / stderr go to separate files (errors must not corrupt the JSON receipt)
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
$res.env = 'windows'

function Fail-Preflight([string]$msg) {
    $res.preflightError = $msg
    return $res
}

# ---------- resolve the executable ----------
function Resolve-ClaudeExe([string]$Explicit) {
    if ($Explicit) {
        if (Test-Path -LiteralPath $Explicit) { return (Resolve-Path -LiteralPath $Explicit).Path }
        $c = Get-Command $Explicit -ErrorAction SilentlyContinue
        if ($c) { return $c.Source }
        return ''
    }
    $c = Get-Command claude.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $candidates = @(
        (Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe'),
        (Join-Path $env:USERPROFILE '.claude\bin\claude.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\claude\claude.exe')
    )
    foreach ($p in $candidates) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    # Last resort: the .cmd shim (%* forwarding is fragile; only used when nothing else exists)
    $c = Get-Command claude.cmd -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $c = Get-Command claude -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    return ''
}

$explicitCmd = ''
if ($Config -and $Config.windowsClaudeCmd) { $explicitCmd = [string]$Config.windowsClaudeCmd }
$exe = Resolve-ClaudeExe $explicitCmd
if (-not $exe) {
    return Fail-Preflight 'claude not found on windows (set windowsClaudeCmd in losflow.config.json)'
}

$ver = Get-DsClaudeVersion $exe
$minVer = '2.1.0'
if (-not (Test-DsVersionAtLeast $ver $minVer)) {
    $shown = if ($ver) { $ver } else { '(unknown)' }
    return Fail-Preflight ("claude version too old or unreadable: {0} (need >= {1})" -f $shown, $minVer)
}
$res.claudeVersion = $ver

# ---------- resolve repo (preflight: path/env mismatch) ----------
if ($Repo -match '^(/|~)') {
    return Fail-Preflight ("env=windows but repo is a POSIX path: {0} (path/env mismatch)" -f $Repo)
}
$repoFull = ''
try {
    if (-not (Test-Path -LiteralPath $Repo -PathType Container)) {
        return Fail-Preflight ("repo not found in windows: {0} (env=windows, path/env mismatch?)" -f $Repo)
    }
    $repoFull = (Resolve-Path -LiteralPath $Repo).Path
} catch {
    return Fail-Preflight ("repo not accessible in windows: {0} ({1})" -f $Repo, $_.Exception.Message)
}

# ---------- auth / isolation ----------
# Explicit windowsClaudeEnv wins: strip ambient ANTHROPIC_* then inject only what is configured.
# Empty config = inherit the ambient Windows environment (user login / shell-exported gateway).
$envPairs = Get-DsEnvPairs $(if ($Config) { $Config.windowsClaudeEnv } else { $null })
if ($envPairs.Count -gt 0) {
    foreach ($name in @('ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN')) {
        Remove-Item ("Env:" + $name) -ErrorAction SilentlyContinue
    }
    foreach ($k in $envPairs.Keys) { Set-Item ("Env:" + $k) $envPairs[$k] }
}
Clear-DsNestingEnv

# ---------- task body -> stdin ----------
$taskInput = $TaskFile
$tempTask = ''
if (-not $taskInput -or -not (Test-Path -LiteralPath $taskInput)) {
    $runDir0 = Get-DsRunStateDir $OutDir
    $tempTask = Join-Path $runDir0 ("{0}.task.md" -f $Id)
    [System.IO.File]::WriteAllText($tempTask, $Task, (New-Object System.Text.UTF8Encoding($false)))
    $taskInput = $tempTask
}

# ---------- artifacts ----------
$runDir = Get-DsRunStateDir $OutDir
$outFile = if ($Stream) { Join-Path $runDir "$Id.stream.jsonl" } else { Join-Path $runDir "$Id.out.json" }
$errFile = Join-Path $runDir "$Id.err"

# ---------- live approval MCP ----------
# Claude Code launches this stdio server itself; it must be a real Python, not the
# Microsoft Store stub. Prefer the py launcher (py -3), then a verified python.exe.
$mcpFile = ''
if ($LiveApprove) {
    $scriptPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'approval-mcp.py'
    if (-not (Test-Path -LiteralPath $scriptPath)) {
        return Fail-Preflight ("approval-mcp.py missing: {0} (set liveApprove=false to disable)" -f $scriptPath)
    }
    $scriptPath = (Resolve-Path -LiteralPath $scriptPath).Path

    $pyExe = ''
    $pyArgs = @()
    $explicitPy = ''
    if ($Config -and $Config.pythonCmd) { $explicitPy = [string]$Config.pythonCmd }
    if ($explicitPy) {
        if (Test-Path -LiteralPath $explicitPy) {
            $pyExe = (Resolve-Path -LiteralPath $explicitPy).Path
        } else {
            $c = Get-Command $explicitPy -ErrorAction SilentlyContinue
            if ($c) { $pyExe = $c.Source }
        }
    } else {
        $c = Get-Command py.exe -ErrorAction SilentlyContinue
        if ($c) {
            $pyExe = $c.Source
            $pyArgs = @('-3')
        } else {
            $c = Get-Command python.exe -ErrorAction SilentlyContinue
            if ($c) {
                $probe = ''
                try { $probe = (& $c.Source -c "print(1)" 2>$null | Out-String).Trim() } catch { }
                if ($probe -eq '1') { $pyExe = $c.Source }
            }
        }
    }
    if (-not $pyExe) {
        return Fail-Preflight 'python not found on windows for live approval (install Python 3, set pythonCmd, or liveApprove=false)'
    }

    $mcpFile = Join-Path $runDir "$Id.mcp.json"
    $mcpObj = [ordered]@{
        mcpServers = [ordered]@{
            'losflow-approval' = [ordered]@{
                command = $pyExe
                args    = @($pyArgs + $scriptPath)
                env     = [ordered]@{
                    LOSFLOW_DATA             = $OutDir
                    LOSFLOW_LIVE_RUN         = $Id
                    LOSFLOW_LIVE_TASK        = $TaskId
                    LOSFLOW_LIVE_REPO        = $repoFull
                    LOSFLOW_APPROVAL_TIMEOUT = [string]$ApprovalTimeoutSec
                }
            }
        }
    }
    try {
        [System.IO.File]::WriteAllText($mcpFile, (ConvertTo-Json -Depth 8 -Compress -InputObject $mcpObj), (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        return Fail-Preflight ("cannot write mcp config: {0}" -f $_.Exception.Message)
    }
}

# ---------- build arguments ----------
$argList = New-Object System.Collections.Generic.List[string]
$argList.Add('-p')
$argList.Add('--output-format')
if ($Stream) {
    $argList.Add('stream-json')
    $argList.Add('--verbose')
} else {
    $argList.Add('json')
}
if ($Allow) {
    $argList.Add('--allowedTools')
    $argList.Add($Allow)
}
if ($Mode -eq 'write') {
    $argList.Add('--permission-mode')
    $argList.Add('acceptEdits')
}
if ($Resume) {
    $argList.Add('--resume')
    $argList.Add($Resume)
}
if ($Model) {
    $argList.Add('--model')
    $argList.Add($Model)
}
if (-not $Mcp) { $argList.Add('--strict-mcp-config') }
if ($LiveApprove) {
    $argList.Add('--mcp-config')
    $argList.Add($mcpFile)
    $argList.Add('--permission-prompt-tool')
    $argList.Add('mcp__losflow-approval__approval_prompt')
    $argList.Add('--permission-prompts')
    $argList.Add('host')
}
if ($MaxBudget -gt 0) {
    $argList.Add('--max-budget-usd')
    $argList.Add($MaxBudget.ToString([System.Globalization.CultureInfo]::InvariantCulture))
}
if ($Config -and $Config.windowsClaudeArgs) {
    foreach ($a in @($Config.windowsClaudeArgs)) {
        if ($null -ne $a -and "$a" -ne '') { $argList.Add([string]$a) }
    }
}
$argString = Join-DsArgs @($argList)

# ---------- start ----------
$res.startedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
$res.jsonPath = $outFile
$res.errPath = $errFile
$res.streamPath = $outFile

$proc = $null
try {
    $proc = Start-Process -FilePath $exe -ArgumentList $argString -WorkingDirectory $repoFull `
        -NoNewWindow -PassThru -RedirectStandardInput $taskInput `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile -ErrorAction Stop
} catch {
    if ($tempTask) { try { Remove-Item $tempTask -Force } catch { } }
    if ($mcpFile) { try { Remove-Item $mcpFile -Force } catch { } }
    return Fail-Preflight ("cannot start claude: {0}" -f $_.Exception.Message)
}
$res.pid = [int]$proc.Id

[void](Write-DsRunState $OutDir ([ordered]@{
            id            = $Id
            taskId        = $TaskId
            env           = 'windows'
            repo          = $repoFull
            stream        = $outFile
            pid           = $res.pid
            startedAt     = $res.startedAt
            claudeVersion = $res.claudeVersion
        }))

# running.json: dashboard's "which task is running right now" (last one wins).
try {
    $rj = [ordered]@{
        id        = $Id
        taskId    = $TaskId
        env       = 'windows'
        status    = 'running'
        startedAt = $res.startedAt
        task      = $Task.Substring(0, [Math]::Min(160, $Task.Length))
        stream    = $outFile
    }
    [System.IO.File]::WriteAllText((Join-Path $OutDir 'running.json'), (ConvertTo-Json -Depth 4 -InputObject $rj), (New-Object System.Text.UTF8Encoding($false)))
} catch { }

# ---------- wait (own timeout, no WSL `timeout` available here) ----------
$exited = $false
try {
    $exited = $proc.WaitForExit($TimeoutSec * 1000)
    if ($exited) { $proc.Refresh(); $res.rc = [int]$proc.ExitCode }
} catch { }

if (-not $exited) {
    # take the whole tree down (claude may have spawned helpers)
    try { & taskkill.exe /T /F /PID $proc.Id | Out-Null } catch {
        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
    }
    $res.rc = 124
}

if ($tempTask) { try { Remove-Item $tempTask -Force } catch { } }
if ($mcpFile) { try { Remove-Item $mcpFile -Force } catch { } }

return $res
