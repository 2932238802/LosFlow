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
