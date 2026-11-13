<#
.SYNOPSIS
    Single source of truth for "where are we now": writes a short progress note that a human
    can glance at, plus a machine-readable twin.

.DESCRIPTION
    Design rules borrowed from the workbench reference (learned, not copied):
      - one place is the truth; everything else points at it
      - explicit empty state: "none" instead of a blank section
      - short on purpose (rendered markdown stays under ~40 lines)

    Files (default dir D:\PROJECT\Ds\_progress):
      <Name>.md    human view
      <Name>.json  machine view (status, done[], evidence[], blocked, decision, next[], events[])

.PARAMETER Name
    Progress file name, e.g. Vesta.

.PARAMETER Status
    running | waiting | done | blocked

.PARAMETER Done
    Append one line to "what just finished".

.PARAMETER Evidence
    Append one line of evidence (command output, file path, numbers).

.PARAMETER Blocked
    Replace the blocking reason. Use -ClearBlocked to empty it.

.PARAMETER Decision
    The decision the human must make (shown only when status is waiting/blocked).

.PARAMETER Next
    Append one line to "next step". Use -ClearNext to reset.

.PARAMETER Show
    Print the current markdown and exit.

.PARAMETER Clear
    Reset everything for this name.

.EXAMPLE
    .\progress.ps1 -Name Vesta -Status running -Done '派单脚本 v2 写好' -Evidence 'claude-dispatch.ps1 干跑通过' -Next '跑真实派单验证'

.EXAMPLE
    .\progress.ps1 -Name Vesta -Status waiting -Decision 'A 继续改 / B 先停' -Blocked '等你拍板'
#>
[CmdletBinding()]
param(
    [string]$Name = 'Vesta',
    [ValidateSet('running', 'waiting', 'done', 'blocked')]
    [string]$Status = 'running',
    [string[]]$Done = @(),
    [string[]]$Evidence = @(),
    [string]$Blocked = '',
    [string]$Decision = '',
    [string[]]$Next = @(),
    [switch]$ClearBlocked,
    [switch]$ClearNext,
    [switch]$Show,
    [switch]$Clear,
    [string]$Dir = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_paths.ps1')
if (-not $Dir) { $Dir = (Get-DsPaths).progressDir }
if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }
$jsonPath = Join-Path $Dir "$Name.json"
$mdPath = Join-Path $Dir "$Name.md"

$state = [pscustomobject]@{
    name     = $Name
    status   = 'running'
    updated  = ''
    done     = @()
    evidence = @()
    blocked  = ''
    decision = ''
    next     = @()
    events   = @()
}
if ((Test-Path $jsonPath) -and -not $Clear) {
    $loaded = [System.IO.File]::ReadAllText($jsonPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $state = $loaded
    $state.name = $Name
}

if ($Show) {
    if (Test-Path $mdPath) { Get-Content $mdPath -Encoding UTF8 | ForEach-Object { Write-Host $_ } }
    else { Write-Host "No progress yet for '$Name'." -ForegroundColor Yellow }
    return
}

if ($Clear) {
    $state.done = @(); $state.evidence = @(); $state.next = @()
    $state.blocked = ''; $state.decision = ''; $state.events = @()
}

$state.status = $Status
foreach ($d in $Done) { if ($d) { $state.done += $d } }
foreach ($e in $Evidence) { if ($e) { $state.evidence += $e } }
if ($ClearNext) { $state.next = @() }
foreach ($n in $Next) { if ($n) { $state.next += $n } }
if ($Blocked) { $state.blocked = $Blocked }
if ($ClearBlocked) { $state.blocked = '' }
if ($Decision) { $state.decision = $Decision }
# keep lists bounded so the rendered note stays short
if ($state.done.Count -gt 12) { $state.done = @($state.done | Select-Object -Last 12) }
if ($state.evidence.Count -gt 12) { $state.evidence = @($state.evidence | Select-Object -Last 12) }
if ($state.next.Count -gt 8) { $state.next = @($state.next | Select-Object -Last 8) }

$now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$state.updated = $now
$eventLine = '{0} [{1}] {2}' -f $now.Substring(11, 5), $Status, (@($Done) -join '; ')
if (-not (@($Done).Count)) { $eventLine = '{0} [{1}] {2}' -f $now.Substring(11, 5), $Status, ($(if ($Blocked) { $Blocked } else { 'update' })) }
$state.events += $eventLine
if ($state.events.Count -gt 12) { $state.events = @($state.events | Select-Object -Last 12) }

$statusZh = @{ running = '进行中'; waiting = '等你拍板'; done = '已收工'; blocked = '卡住' }
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("# $Name · 当前进度")
[void]$sb.AppendLine("")
[void]$sb.AppendLine(('- 状态：**{0}**' -f $statusZh[$state.status]))
[void]$sb.AppendLine(('- 更新：{0}' -f $state.updated))
[void]$sb.AppendLine("")
[void]$sb.AppendLine("## 刚做完")
if (@($state.done).Count -eq 0) { [void]$sb.AppendLine("- 无") }
else { foreach ($d in $state.done) { [void]$sb.AppendLine("- $d") } }
[void]$sb.AppendLine("")
[void]$sb.AppendLine("## 证据")
if (@($state.evidence).Count -eq 0) { [void]$sb.AppendLine("- 无") }
else { foreach ($e in $state.evidence) { [void]$sb.AppendLine("- $e") } }
[void]$sb.AppendLine("")
[void]$sb.AppendLine("## 卡在哪")
if (-not $state.blocked) { [void]$sb.AppendLine("- 无") }
else { [void]$sb.AppendLine("- $($state.blocked)") }
if ($state.decision -and ($state.status -eq 'waiting' -or $state.status -eq 'blocked')) {
    [void]$sb.AppendLine(('- 需要你决定：{0}' -f $state.decision))
}
[void]$sb.AppendLine("")
[void]$sb.AppendLine("## 下一步")
if (@($state.next).Count -eq 0) { [void]$sb.AppendLine("- 无") }
else { foreach ($n in $state.next) { [void]$sb.AppendLine("- $n") } }
[void]$sb.AppendLine("")
[void]$sb.AppendLine("## 事件")
foreach ($ev in @($state.events | Select-Object -Last 6)) { [void]$sb.AppendLine("- $ev") }

[System.IO.File]::WriteAllText($mdPath, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText($jsonPath, ($state | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))

[pscustomobject]@{
    name = $Name; status = $state.status; updated = $state.updated
    md = $mdPath; json = $jsonPath
    done = @($state.done).Count; next = @($state.next).Count; blocked = $state.blocked
}
