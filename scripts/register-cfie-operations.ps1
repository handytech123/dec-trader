param(
  [string]$BackupTime = "03:00"
)

$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$supervisorScript = Join-Path $workspace "scripts\run-cfie-supervisor.ps1"
$backupScript = Join-Path $workspace "scripts\run-cfie-backup-task.ps1"
$windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$pwshCommand = Get-Command pwsh.exe -ErrorAction SilentlyContinue
# Prefer the stable system host for unattended tasks. Bundled application runtimes can move or
# carry session-specific type data that is unsuitable for Task Scheduler.
$pwsh = if (Test-Path -LiteralPath $windowsPowerShell) { $windowsPowerShell } elseif (
  $null -ne $pwshCommand
) {
  $pwshCommand.Source
} else {
  $windowsPowerShell
}
if (-not (Test-Path -LiteralPath $pwsh)) { throw "PowerShell was not found" }
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

$supervisorAction = New-ScheduledTaskAction -Execute $pwsh `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$supervisorScript`""
$supervisorTrigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
Register-ScheduledTask -TaskName "CFIE Read-Only Supervisor" -Action $supervisorAction `
  -Trigger $supervisorTrigger -Settings $settings -Principal $principal -Force | Out-Null

$backupAt = [datetime]::ParseExact($BackupTime, "HH:mm", [Globalization.CultureInfo]::InvariantCulture)
$backupAction = New-ScheduledTaskAction -Execute $pwsh `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$backupScript`""
$backupTrigger = New-ScheduledTaskTrigger -Daily -At $backupAt
$backupSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 8) -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName "CFIE Daily PostgreSQL Backup" -Action $backupAction `
  -Trigger $backupTrigger -Settings $backupSettings -Principal $principal -Force | Out-Null

Get-ScheduledTask -TaskName "CFIE Read-Only Supervisor", "CFIE Daily PostgreSQL Backup" |
  Select-Object TaskName, State
