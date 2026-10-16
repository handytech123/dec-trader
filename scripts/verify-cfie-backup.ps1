param(
  [string]$BackupDirectory = "D:\CFIE\backups",
  [string]$BackupPath
)

$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$backupRoot = if ([System.IO.Path]::IsPathRooted($BackupDirectory)) {
  [System.IO.Path]::GetFullPath($BackupDirectory)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $workspace $BackupDirectory))
}
$workspacePrefix = $workspace.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$approvedExternalRoot = "D:\CFIE\backups"
$approvedExternalPrefix = $approvedExternalRoot + [System.IO.Path]::DirectorySeparatorChar
if (-not $backupRoot.StartsWith($workspacePrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
    -not $backupRoot.Equals($approvedExternalRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
    -not $backupRoot.StartsWith($approvedExternalPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Backup directory must remain inside the workspace or D:\CFIE\backups"
}
$selected = if ([string]::IsNullOrWhiteSpace($BackupPath)) {
  Get-ChildItem -LiteralPath $backupRoot -Filter "cfie-*.dump" -File |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
} else {
  $requestedBackup = if ([System.IO.Path]::IsPathRooted($BackupPath)) {
    [System.IO.Path]::GetFullPath($BackupPath)
  } else {
    [System.IO.Path]::GetFullPath((Join-Path $workspace $BackupPath))
  }
  Get-Item -LiteralPath $requestedBackup
}
if ($null -eq $selected) { throw "No CFIE backup was found" }
$resolvedBackup = [System.IO.Path]::GetFullPath($selected.FullName)
$backupPrefix = $backupRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $resolvedBackup.StartsWith($backupPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Backup must remain inside the configured backup directory"
}
$manifestPath = "$resolvedBackup.json"
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Backup manifest is missing" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$actualHash = (Get-FileHash -LiteralPath $resolvedBackup -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $manifest.sha256) { throw "Backup SHA-256 does not match its manifest" }
if ((Get-Item -LiteralPath $resolvedBackup).Length -ne $manifest.bytes) {
  throw "Backup byte length does not match its manifest"
}
$pgRestore = "C:\Program Files\PostgreSQL\17\bin\pg_restore.exe"
if (-not (Test-Path -LiteralPath $pgRestore)) { throw "PostgreSQL pg_restore was not found" }
$nullDevice = if ($IsWindows -or $env:OS -eq "Windows_NT") { "NUL" } else { "/dev/null" }
& $pgRestore --list $resolvedBackup | Out-Null
if ($LASTEXITCODE -ne 0) { throw "pg_restore archive listing failed" }
& $pgRestore --data-only --file=$nullDevice $resolvedBackup
if ($LASTEXITCODE -ne 0) { throw "pg_restore data-stream verification failed" }
$report = [ordered]@{
  authority = "READ_ONLY_BACKUP_VERIFICATION"
  verifiedAt = (Get-Date).ToUniversalTime().ToString("o")
  backupPath = $resolvedBackup
  createdAt = $manifest.createdAt
  bytes = $manifest.bytes
  sha256 = $actualHash
  archiveListing = "PASS"
  dataStream = "PASS"
}
$reportPath = Join-Path $backupRoot "latest-verification.json"
$report | ConvertTo-Json | Set-Content -LiteralPath $reportPath -Encoding utf8
$report | ConvertTo-Json
