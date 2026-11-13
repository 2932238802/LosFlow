# win-notify.ps1 -- show a Windows balloon notification for an approval request.
# ASCII only: Windows PowerShell 5.1 parses a UTF-8 no-BOM .ps1 as ANSI, so the
# Chinese payload is passed in as base64 JSON (-PayloadB64) and decoded here.
#
# Why NotifyIcon: WinRT ToastNotificationManager requires package identity
# (0x80073D54 in an unpackaged process). NotifyIcon.ShowBalloonTip works on
# Win10/11 without packaging; the system renders it in the notification area.
param(
    [Parameter(Mandatory = $true)][string]$PayloadB64,
    [int]$Seconds = 6
)

$ErrorActionPreference = 'Stop'
try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadB64))
    $payload = $json | ConvertFrom-Json
}
catch {
    [Console]::Error.WriteLine("bad payload: " + $_.Exception.Message)
    exit 1
}

$title = [string]$payload.title
$body = [string]$payload.body
$sound = $true
if ($null -ne $payload.sound) { $sound = [bool]$payload.sound }
if (-not $title) { $title = 'LosFlow' }
if (-not $body) { $body = 'AUTH request waiting' }
$title = $title.Substring(0, [Math]::Min(63, $title.Length))
if ($body.Length -gt 255) { $body = $body.Substring(0, 252) + '...' }

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    if ($sound) { [System.Media.SystemSounds]::Exclamation.Play() }

    $icon = New-Object System.Windows.Forms.NotifyIcon
    $icon.Icon = [System.Drawing.SystemIcons]::Information
    $icon.BalloonTipTitle = $title
    $icon.BalloonTipText = $body
    $icon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
    $icon.Visible = $true
    $icon.ShowBalloonTip(6000)

    # Keep the process alive while the balloon is on screen; dispose afterwards.
    Start-Sleep -Seconds ([Math]::Max(1, [Math]::Min(10, $Seconds)))
    $icon.Visible = $false
    $icon.Dispose()
    exit 0
}
catch {
    # Last resort: at least make a sound so the request is not silent.
    try { [System.Media.SystemSounds]::Exclamation.Play() } catch { }
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
