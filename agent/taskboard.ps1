<#
.SYNOPSIS
    Canonical task list for a run, with an export in WorkBuddy's TodoWrite shape.

.DESCRIPTION
    Why a separate store: WorkBuddy keeps its task table inside its own private session
    directory (~/.workbuddy/tasks/<session-id>/N.json). Writing there was NOT verified
    against a running GUI, and a wrong write can corrupt its state. So this tool keeps the
    list itself and exports a file in the same shape, which you paste/import by hand.

    Store : D:\PROJECT\Ds\_progress\<Name>.tasks.json
    Export: D:\PROJECT\Ds\_progress\wb-tasks.json  (TodoWrite-shaped array)

    WorkBuddy field mapping: pending / in_progress / completed, plus subject, description,
    activeForm, id, createdAt, updatedAt.

.PARAMETER Name
    Task list name. Default Vesta.

.PARAMETER Add
    Add a task by title. Optional -Owner and -Note.
    Tencent-docs write instructions are rejected: that work goes through the docsync queue
    (wb-bridge next_docsync / report_docsync), never a task row.

.PARAMETER Set
    Task id to update. Requires -Status. Optional -Evidence, -Owner, -Note.

.PARAMETER Status
    todo | doing | done | blocked

.PARAMETER List
    Print the current list.

.PARAMETER Remove
    Remove a task id.

.PARAMETER Export
    Write the WorkBuddy-shaped export file.

.EXAMPLE
    .\taskboard.ps1 -Add 'Fix skip-logic in questionnaire' -Owner claude-code

.EXAMPLE
    .\taskboard.ps1 -Set 1 -Status done -Evidence 'npm run typecheck ok, 3 files changed'
#>
[CmdletBinding()]
param(
    [string]$Name = 'Vesta',
    [string]$Add = '',
    [string]$Set = '',
    [ValidateSet('todo', 'doing', 'done', 'blocked')]
    [string]$Status = 'todo',
    [string]$Evidence = '',
    [string]$Owner = '',
    [string]$Note = '',
    [string]$Remove = '',
    [switch]$List,
    [switch]$Export,
    [string]$Dir = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_paths.ps1')
if (-not $Dir) { $Dir = (Get-DsPaths).progressDir }
if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }
$store = Join-Path $Dir "$Name.tasks.json"

$tasks = @()
if (Test-Path $store) {
    $loaded = [System.IO.File]::ReadAllText($store, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($loaded) { $tasks = @($loaded) }
}

$now = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
$ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

function Save-Tasks {
    [System.IO.File]::WriteAllText($store, (ConvertTo-Json -InputObject @($tasks) -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
}

if ($Add) {
    # 写腾讯文档是默认后台行为：只走 docsync 队列 → WorkBuddy，不占任务表、不进终端。
    # 判定以连接器配置为准（server/cli/docsync-check.mjs）；node 不可用时退回旧正则。
    $cfgPaths = Get-DsPaths
    $docText = "$Add`n$Note"
    $looksLikeDoc = $false
    $checker = Join-Path (Split-Path $PSScriptRoot -Parent) 'server\cli\docsync-check.mjs'
    if (Test-Path $checker) {
        try {
            & $cfgPaths.nodeExe $checker $docText 2>$null
            $looksLikeDoc = ($LASTEXITCODE -eq 1)
        } catch {
            $looksLikeDoc = $false
        }
    }
    if (-not $looksLikeDoc) {
        # 兜底：连接器判定不可用时，仍拦住最典型的腾讯文档指令
        $looksLikeDoc = ($docText -match 'append-row|update-row|整理(腾讯文档)?主表|腾讯文档任务表') -or
                        (($docText -match 'docs\.qq\.com') -and ($docText -match '追加|新增|写入|补写|整理|归档|移(到|入|出|至)'))
    }
    if ($looksLikeDoc) {
        throw '拒绝建任务：这是腾讯文档操作指令。写表格请走文档同步队列（WorkBuddy 的 next_docsync / report_docsync），它不占任务行、不进终端。'
    }
    $nextId = 1
    if ($tasks.Count -gt 0) {
        $maxId = 0
        foreach ($t in $tasks) { if ([int]$t.id -gt $maxId) { $maxId = [int]$t.id } }
        $nextId = $maxId + 1
    }
    $tasks += [pscustomobject]@{
        id         = "$nextId"
        subject    = $Add
        owner      = $Owner
        note       = $Note
        status     = 'todo'
        evidence   = ''
        createdAt  = $ts
        updatedAt  = $ts
    }
    Save-Tasks
    Write-Host ("Added #{0}: {1}" -f $nextId, $Add) -ForegroundColor Green
}

if ($Set) {
    $found = $false
    foreach ($t in $tasks) {
        if ($t.id -eq $Set) {
            $t.status = $Status
            $t.updatedAt = $ts
            if ($Evidence) { $t.evidence = $Evidence }
            if ($Owner) { $t.owner = $Owner }
            if ($Note) { $t.note = $Note }
            $found = $true
        }
    }
    if (-not $found) { throw "No task with id $Set" }
    Save-Tasks
    Write-Host ("Updated #{0} -> {1}" -f $Set, $Status) -ForegroundColor Green
}

if ($Remove) {
    $before = $tasks.Count
    $tasks = @($tasks | Where-Object { $_.id -ne $Remove })
    if ($tasks.Count -eq $before) { throw "No task with id $Remove" }
    Save-Tasks
    Write-Host ("Removed #{0}" -f $Remove) -ForegroundColor Yellow
}

if ($Export) {
    $wb = @()
    foreach ($t in $tasks) {
        $wbStatus = switch ($t.status) {
            'done' { 'completed' }
            'doing' { 'in_progress' }
            'blocked' { 'pending' }
            default { 'pending' }
        }
        $desc = @()
        if ($t.note) { $desc += $t.note }
        if ($t.owner) { $desc += "owner: $($t.owner)" }
        if ($t.evidence) { $desc += "evidence: $($t.evidence)" }
        $wb += [pscustomobject]@{
            subject     = [string]$t.subject
            description = ($desc -join ' | ')
            activeForm  = [string]$t.subject
            status      = $wbStatus
            id          = [string]$t.id
            createdAt   = [int64]$t.createdAt
            updatedAt   = [int64]$t.updatedAt
        }
    }
    $exportPath = Join-Path $Dir 'wb-tasks.json'
    [System.IO.File]::WriteAllText($exportPath, (ConvertTo-Json -InputObject @($wb) -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Exported to $exportPath" -ForegroundColor Green
    Write-Host "WorkBuddy stores tasks at ~/.workbuddy/tasks/<session-id>/N.json; import by hand." -ForegroundColor Yellow
}

# always print the list at the end
Write-Host ''
if ($tasks.Count -eq 0) { Write-Host "(task list '$Name' is empty)" -ForegroundColor Yellow; return }
$tasks | Select-Object @{n = 'id'; e = { $_.id } },
@{n = 'status'; e = { $_.status } },
@{n = 'owner'; e = { $_.owner } },
@{n = 'subject'; e = { $_.subject } },
@{n = 'evidence'; e = { if ($_.evidence.Length -gt 40) { $_.evidence.Substring(0, 40) + '...' } else { $_.evidence } } } |
Format-Table -AutoSize
