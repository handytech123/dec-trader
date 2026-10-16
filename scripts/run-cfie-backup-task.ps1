$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtimeRoot = Join-Path $workspace ".atl-data\cfie-supervisor"
[System.IO.Directory]::CreateDirectory($runtimeRoot) | Out-Null
$logPath = Join-Path $runtimeRoot "backup-task.log"
$startedAt = (Get-Date).ToUniversalTime().ToString("o")
Add-Content -LiteralPath $logPath -Value "$startedAt START daily PostgreSQL backup"
try {
  & (Join-Path $PSScriptRoot "backup-cfie-postgres.ps1") 2>&1 |
    ForEach-Object { Add-Content -LiteralPath $logPath -Value $_; $_ }
  $completedAt = (Get-Date).ToUniversalTime().ToString("o")
  Add-Content -LiteralPath $logPath -Value "$completedAt PASS daily PostgreSQL backup"
} catch {
  $failedAt = (Get-Date).ToUniversalTime().ToString("o")
  Add-Content -LiteralPath $logPath -Value "$failedAt FAIL $($_.Exception.Message)"
  throw
}
