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
        nodeExe       = 'node'
        workbuddyHome = (Join-Path $env:USERPROFILE '.workbuddy')
        dashboardPort = 8899
    }

    # Machine-specific overrides: <repo>/losflow.config.json (gitignored)
    $file = Join-Path $repo 'losflow.config.json'
    if (Test-Path $file) {
        try {
            $j = Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($k in $j.PSObject.Properties.Name) {
                if ($null -ne $j.$k -and "$($j.$k)" -ne '') { $defaults[$k] = $j.$k }
            }
        } catch {
            Write-Warning "losflow.config.json parse failed, using defaults: $($_.Exception.Message)"
        }
    }
    return [pscustomobject]$defaults
}
