# _common.ps1 -- helpers shared by runners/run-wsl.ps1 and runners/run-windows.ps1.
# ASCII only: Windows PowerShell 5.1 parses .ps1 as ANSI unless the file has a UTF-8 BOM.
#
# The runners only execute; de-dupe / budget / resume / allowlist / receipt parsing /
# ledger / approvals / running.json stay in claude-dispatch.ps1 (the orchestrator).

function Get-DsRunStateDir([string]$OutDir) {
    $dir = Join-Path $OutDir 'runstate'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    return $dir
}

function Write-DsRunState([string]$OutDir, $Data) {
    try {
        $dir = Get-DsRunStateDir $OutDir
        $file = Join-Path $dir ("{0}.json" -f $Data.id)
        $json = ConvertTo-Json -Depth 5 -InputObject $Data -Compress
        [System.IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding($false)))
        return $file
    } catch {
        return ''
    }
}

function Remove-DsRunState([string]$OutDir, [string]$Id) {
    try {
        $file = Join-Path (Join-Path $OutDir 'runstate') ("{0}.json" -f $Id)
        if (Test-Path $file) { Remove-Item $file -Force }
    } catch { }
}

# MSVC / CommandLineToArgvW quoting: one argument -> one token.
# Needed because Start-Process joins -ArgumentList with spaces and does not quote for us.
function Quote-DsArg([string]$s) {
    if ($null -eq $s) { return '""' }
    if ($s -eq '') { return '""' }
    if ($s -notmatch '[\s"]' -and -not $s.EndsWith('\')) { return $s }
    $b = [regex]::Replace($s, '(\\*)"', '$1$1\"')
    $b = [regex]::Replace($b, '(\\+)$', '$1$1')
    return '"' + $b + '"'
}

function Join-DsArgs([string[]]$list) {
    return (($list | ForEach-Object { Quote-DsArg $_ }) -join ' ')
}

# "2.1.323 (Claude Code)" -> "2.1.323"
function Get-DsClaudeVersion([string]$Exe) {
    try {
        $txt = (& $Exe --version 2>$null | Select-Object -First 1)
        if ("$txt" -match '(\d+\.\d+\.\d+)') { return [string]$Matches[1] }
    } catch { }
    return ''
}

function Test-DsVersionAtLeast([string]$Have, [string]$Need) {
    try {
        if (-not $Have) { return $false }
        return ([version]$Have -ge [version]$Need)
    } catch {
        return $false
    }
}

function New-DsRunnerResult {
    return [pscustomobject]@{
        rc             = $null
        jsonPath       = ''
        errPath        = ''
        streamPath     = ''
        pid            = 0
        env            = ''
        claudeVersion  = ''
        startedAt      = ''
        preflightError = ''
    }
}

# D:\PROJECT\LosFlow\agent\approval-mcp.py -> /mnt/d/PROJECT/LosFlow/agent/approval-mcp.py
function ConvertTo-DsWslPath([string]$WinPath) {
    if (-not $WinPath) { return '' }
    $p = $WinPath.Replace('\', '/')
    if ($p -match '^([A-Za-z]):/(.*)$') {
        return ('/mnt/{0}/{1}' -f $Matches[1].ToLowerInvariant(), $Matches[2])
    }
    return $p
}

# losflow.config.json gives a PSCustomObject; tests / dot-sourcing may give a Hashtable.
function Get-DsEnvPairs($EnvCfg) {
    $pairs = @{}
    if ($null -eq $EnvCfg) { return $pairs }
    if ($EnvCfg -is [System.Collections.IDictionary]) {
        foreach ($k in $EnvCfg.Keys) {
            if ($null -ne $EnvCfg[$k] -and "$($EnvCfg[$k])" -ne '') { $pairs[[string]$k] = [string]$EnvCfg[$k] }
        }
    } else {
        foreach ($p in $EnvCfg.PSObject.Properties) {
            if ($null -ne $p.Value -and "$($p.Value)" -ne '') { $pairs[$p.Name] = [string]$p.Value }
        }
    }
    return $pairs
}

# Never let a dispatch inherit "I am running inside another Claude Code session" markers.
$script:DsNestingVars = @(
    'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT',
    'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH'
)

function Clear-DsNestingEnv {
    foreach ($name in $script:DsNestingVars) {
        Remove-Item ("Env:" + $name) -ErrorAction SilentlyContinue
    }
}
