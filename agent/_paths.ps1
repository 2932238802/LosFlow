# _paths.ps1 -- resolve LosFlow paths. Defaults live inside the repository.
# ASCII only: Windows PowerShell 5.1 parses .ps1 as ANSI unless the file has a UTF-8 BOM.
#
# Usage (from any script in agent\):
#   . (Join-Path $PSScriptRoot '_paths.ps1')
#   $cfg = Get-DsPaths
#   $ledger = Join-Path $cfg.toolsDir 'claude-ledger.jsonl'

function Get-DsPaths {
    $repo = Split-Path $PSScriptRoot -Parent
    $defaults = [ordered]@{
        dsRoot        = $repo
        toolsDir      = (Join-Path $repo 'data')
        progressDir   = (Join-Path $repo 'data')
        agentDir      = $PSScriptRoot
        tempDir       = (Join-Path $repo '.tmp')
        wslDistro     = 'Ubuntu-26.04'
        wslRepo       = '~/LosAngelous/Vesta'
        # Dispatch environment for an empty repo (keep the old behaviour = wsl)
        defaultEnv    = 'wsl'
        # Windows-side Claude Code. Empty = auto-resolve (see runners/run-windows.ps1)
        windowsClaudeCmd  = ''
        windowsClaudeArgs = @()
        # Env vars injected into the Windows child process (JZ gateway trio lives here;
        # the key must only be written to losflow.config.json, never committed)
        windowsClaudeEnv  = @{}
        claudeTimeoutSec  = 600
        # Live approval: --permission-prompt-tool -> agent/approval-mcp.py.
        # Set liveApprove=false to fall back to today's "run first, ask later" behaviour.
        liveApprove       = $true
        approvalTimeoutSec = 50
        # Optional Python for approval-mcp.py on Windows. Empty = auto (py -3 / python)
        pythonCmd         = ''
        runstateDir   = (Join-Path $repo 'data\runstate')
        nodeExe       = 'node'
        workbuddyHome = (Join-Path $env:USERPROFILE '.workbuddy')
        dashboardPort = 8899
    }

    $cfgRunstate = $null
    # Machine-specific overrides: <repo>/losflow.config.json (gitignored)
    $file = Join-Path $repo 'losflow.config.json'
    if (Test-Path $file) {
        try {
            $j = Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($k in $j.PSObject.Properties.Name) {
                if ($null -ne $j.$k -and "$($j.$k)" -ne '') { $defaults[$k] = $j.$k }
            }
            if ($j.PSObject.Properties.Name -contains 'runstateDir') { $cfgRunstate = $j.runstateDir }
        } catch {
            Write-Warning "losflow.config.json parse failed, using defaults: $($_.Exception.Message)"
        }
    }
    # runstate follows the data dir unless explicitly configured
    if (-not $cfgRunstate) { $defaults.runstateDir = Join-Path $defaults.progressDir 'runstate' }
    return [pscustomobject]$defaults
}

# Resolve the dispatch environment for a repo path.
# MUST match server/env.mjs resolveEnv() rule for rule (see that file for the rationale).
function Resolve-DsEnv {
    param(
        [string]$Path = '',
        [string]$Explicit = '',
        [string]$DefaultEnv = 'wsl'
    )
    $ex = "$Explicit".Trim().ToLowerInvariant()
    if ($ex -eq 'wsl' -or $ex -eq 'windows') { return $ex }

    $p = "$Path".Trim()
    if (-not $p) {
        if ("$DefaultEnv".Trim().ToLowerInvariant() -eq 'windows') { return 'windows' }
        return 'wsl'
    }
    # UNC must be tested before the leading-slash rule
    if ($p.StartsWith('\\') -or $p.StartsWith('//')) { return 'windows' }
    if ($p -match '^[A-Za-z]:[\\/]') { return 'windows' }
    # POSIX absolute path / home dir (includes /mnt/d/... on purpose)
    if ($p.StartsWith('/') -or $p.StartsWith('~/')) { return 'wsl' }
    return 'windows'
}
