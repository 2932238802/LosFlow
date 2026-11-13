<#
.SYNOPSIS
    Query the claude-dispatch ledger: spend, open dispatches, latest sessions.

.DESCRIPTION
    The ledger is JSONL, one row per dispatch, written by claude-dispatch.ps1.
    Default location: D:\PROJECT\Ds\tools\claude-ledger.jsonl

.PARAMETER Query
    summary  counts by status + total and today's spend (default)
    open     dispatches that did not end in ok (denied / error / timeout / unparsed)
    cost     spend per day, newest first
    sessions latest session_id per repo (use with -Resume)
    all      newest 20 rows

.PARAMETER Since
    Limit to the last N days. Default 14. Use 0 for everything.

.PARAMETER Repo
    Filter by repo as recorded in the ledger.

.EXAMPLE
    .\claude-ledger.ps1 -Query open

.EXAMPLE
    .\claude-ledger.ps1 -Query cost -Since 7
#>
[CmdletBinding()]
param(
    [ValidateSet('summary', 'open', 'cost', 'sessions', 'all')]
    [string]$Query = 'summary',
    [int]$Since = 14,
    [string]$Repo = '',
    [string]$Ledger = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_paths.ps1')
if (-not $Ledger) { $Ledger = Join-Path (Get-DsPaths).toolsDir 'claude-ledger.jsonl' }
if (-not (Test-Path $Ledger)) { throw "Ledger not found: $Ledger" }

$rows = @()
foreach ($l in [System.IO.File]::ReadAllLines($Ledger, [System.Text.Encoding]::UTF8)) {
    if (-not $l.Trim()) { continue }
    try { $rows += ($l | ConvertFrom-Json) } catch { }
}
if ($Repo) { $rows = @($rows | Where-Object { $_.repo -eq $Repo }) }
if ($Since -gt 0) {
    $cut = (Get-Date).AddDays(-$Since)
    $rows = @($rows | Where-Object {
            $_.at -and ([datetime]::ParseExact($_.at, 'yyyy-MM-dd HH:mm:ss', $null) -ge $cut)
        })
}
if ($rows.Count -eq 0) { Write-Host 'No ledger rows match.' -ForegroundColor Yellow; return }

switch ($Query) {
    'summary' {
        $byStatus = $rows | Group-Object status | Sort-Object Count -Descending
        $byStatus | Select-Object @{n = 'status'; e = { $_.Name } }, Count | Format-Table -AutoSize
        $total = 0.0; $okCost = 0.0; $failCost = 0.0; $tok = 0
        foreach ($r in $rows) {
            $c = 0.0; if ($r.cost_usd) { $c = [double]$r.cost_usd }
            $total += $c
            if ($r.status -eq 'ok') { $okCost += $c } else { $failCost += $c }
            if ($r.input_tokens) { $tok += [int64]$r.input_tokens }
        }
        $today = (Get-Date).ToString('yyyy-MM-dd')
        $todayCost = 0.0
        foreach ($r in $rows) { if ($r.at -and $r.at.StartsWith($today) -and $r.cost_usd) { $todayCost += [double]$r.cost_usd } }
        [pscustomobject]@{
            rows            = $rows.Count
            total_usd       = [math]::Round($total, 3)
            today_usd       = [math]::Round($todayCost, 3)
            ok_usd          = [math]::Round($okCost, 3)
            wasted_usd      = [math]::Round($failCost, 3)
            input_tokens    = $tok
            wasted_share    = if ($total -gt 0) { '{0:P0}' -f ($failCost / $total) } else { 'n/a' }
        } | Format-List
    }
    'open' {
        $open = @($rows | Where-Object { $_.status -ne 'ok' })
        if ($open.Count -eq 0) { Write-Host 'Nothing open: every dispatch ended ok.' -ForegroundColor Green; return }
        $open | Select-Object at, id, status, rc,
        @{n = 'turns'; e = { $_.turns } },
        @{n = 'cost'; e = { $_.cost_usd } },
        @{n = 'denials'; e = { ($_.denials -join ',') } },
        @{n = 'fix'; e = { ($_.suggested_allow -join ' ') } } |
        Sort-Object at | Format-Table -AutoSize
    }
    'cost' {
        $rows | Group-Object { ($_.at -split ' ')[0] } | Sort-Object Name -Descending | ForEach-Object {
            $sum = 0.0
            foreach ($r in $_.Group) { if ($r.cost_usd) { $sum += [double]$r.cost_usd } }
            [pscustomobject]@{
                day   = $_.Name
                runs  = $_.Count
                usd   = [math]::Round($sum, 3)
                perRun = [math]::Round($sum / $_.Count, 3)
            }
        } | Format-Table -AutoSize
    }
    'sessions' {
        $rows | Where-Object { $_.session_id } | Group-Object repo | ForEach-Object {
            $last = $_.Group | Sort-Object at | Select-Object -Last 1
            [pscustomobject]@{
                repo       = $_.Name
                session_id = $last.session_id
                last_at    = $last.at
                last_status = $last.status
                runs       = $_.Count
            }
        } | Format-Table -AutoSize
    }
    'all' {
        $rows | Select-Object -Last 20 | Select-Object at, id, status, rc,
        @{n = 'turns'; e = { $_.turns } },
        @{n = 'cost'; e = { $_.cost_usd } },
        @{n = 'tok'; e = { $_.input_tokens } },
        @{n = 'resumed'; e = { [bool]$_.resumed_from } } |
        Format-Table -AutoSize
    }
}
