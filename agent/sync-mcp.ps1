<#
.SYNOPSIS
    Regenerate ~/.workbuddy/mcp.json from tools\paths.json (absolute paths only).

.DESCRIPTION
    The WorkBuddy side needs absolute paths, so after moving the workspace or changing the
    Node location, run this instead of hand-editing the JSON.

.EXAMPLE
    .\sync-mcp.ps1

.EXAMPLE
    .\sync-mcp.ps1 -Show
#>
[CmdletBinding()]
param(
    [switch]$Show,
    [string]$Target = ''
)

. (Join-Path $PSScriptRoot '_paths.ps1')
$cfg = Get-DsPaths

$server = Join-Path $cfg.agentDir 'wb-bridge\server.mjs'
if (-not (Test-Path $server)) { throw "bridge server not found: $server" }
if (-not (Test-Path $cfg.nodeExe)) { throw "node not found: $($cfg.nodeExe)" }

if (-not $Target) { $Target = Join-Path $cfg.workbuddyHome 'mcp.json' }

$obj = [ordered]@{
    mcpServers = [ordered]@{
        'ds-taskboard' = [ordered]@{
            command = $cfg.nodeExe
            args    = @($server)
            env     = [ordered]@{
                LOSFLOW_DATA            = $cfg.progressDir
                LOSFLOW_CONNECTORS_FILE = (Join-Path $cfg.progressDir 'connectors.json')
            }
        }
    }
}
$json = $obj | ConvertTo-Json -Depth 6

if ($Show) { Write-Host $json; return }

[System.IO.File]::WriteAllText($Target, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "written: $Target"
Write-Host "next: in WorkBuddy open 连接器管理 → 自定义连接器 → 给 ds-taskboard 点一次信任"
