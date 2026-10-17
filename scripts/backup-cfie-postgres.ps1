param(
  [string]$OutputDirectory = "Z:\CFIE\backups",
  [string]$Database = "cfie_research",
  [string]$Role = "cfie_app",
  [string]$HostName = "127.0.0.1",
  [int]$Port = 5432,
  [int]$MaximumBackups = 2,
  [int]$MinimumFreeGiBAfterBackup = 10
)

$ErrorActionPreference = "Stop"

if ($Port -lt 1 -or $Port -gt 65535) { throw "Port must be between 1 and 65535" }
if ($Database -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "Database name is invalid" }
if ($Role -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "Role name is invalid" }
if ($MaximumBackups -lt 1 -or $MaximumBackups -gt 365) {
  throw "MaximumBackups must be between 1 and 365"
}
if ($MinimumFreeGiBAfterBackup -lt 5 -or $MinimumFreeGiBAfterBackup -gt 1024) {
  throw "MinimumFreeGiBAfterBackup must be between 5 and 1024"
}

$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$backupRoot = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
  [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $workspace $OutputDirectory))
}
$workspacePrefix = $workspace.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$approvedExternalRoot = "Z:\CFIE\backups"
$approvedExternalPrefix = $approvedExternalRoot + [System.IO.Path]::DirectorySeparatorChar
if (-not $backupRoot.StartsWith($workspacePrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
    -not $backupRoot.Equals($approvedExternalRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
    -not $backupRoot.StartsWith($approvedExternalPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Backup directory must remain inside the workspace or Z:\CFIE\backups"
}
[System.IO.Directory]::CreateDirectory($backupRoot) | Out-Null
$backupDrive = Get-PSDrive -Name ([System.IO.Path]::GetPathRoot($backupRoot).Substring(0, 1))
$completeBackups = @(Get-ChildItem -LiteralPath $backupRoot -Filter "cfie-*.dump" -File |
  Where-Object { Test-Path -LiteralPath "$($_.FullName).json" } |
  Sort-Object LastWriteTimeUtc -Descending)
$latestBackup = $completeBackups | Select-Object -First 1
$estimatedBackupBytes = if ($null -eq $latestBackup) { 1GB } else { [math]::Ceiling($latestBackup.Length * 1.25) }
$requiredFreeBytes = $estimatedBackupBytes + ($MinimumFreeGiBAfterBackup * 1GB)
if ($backupDrive.Free -lt $requiredFreeBytes -and $completeBackups.Count -gt 1) {
  $verificationPath = Join-Path $backupRoot "latest-verification.json"
  if (-not (Test-Path -LiteralPath $verificationPath)) {
    throw "Backup preflight cannot prune without a latest verification report"
  }
  $latestVerification = Get-Content -LiteralPath $verificationPath -Raw | ConvertFrom-Json
  if (-not $latestVerification.backupPath -or
      -not ([System.IO.Path]::GetFullPath([string]$latestVerification.backupPath)).Equals(
        [System.IO.Path]::GetFullPath($latestBackup.FullName),
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
    throw "Backup preflight cannot prune because the newest complete backup is not verified"
  }
  foreach ($candidate in @($completeBackups | Select-Object -Skip 1 | Sort-Object LastWriteTimeUtc)) {
    if ($backupDrive.Free -ge $requiredFreeBytes) { break }
    $resolvedCandidate = [System.IO.Path]::GetFullPath($candidate.FullName)
    $backupPrefix = $backupRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolvedCandidate.StartsWith($backupPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to prune a backup outside the configured backup directory"
    }
    Remove-Item -LiteralPath $resolvedCandidate
    Remove-Item -LiteralPath "$resolvedCandidate.json" -ErrorAction SilentlyContinue
    $backupDrive = Get-PSDrive -Name ([System.IO.Path]::GetPathRoot($backupRoot).Substring(0, 1))
  }
}
if ($backupDrive.Free -lt $requiredFreeBytes) {
  throw ("Backup preflight refused: {0:N2} GiB free, {1:N2} GiB required to preserve the post-backup reserve" -f ($backupDrive.Free / 1GB), ($requiredFreeBytes / 1GB))
}

$workspaceProfile = Split-Path (Split-Path (Split-Path $workspace -Parent) -Parent) -Parent
$defaultSecretPath = Join-Path $env:LOCALAPPDATA "CFIE\cfie-postgres-password.dpapi"
$profileSecretPath = Join-Path $workspaceProfile "AppData\Local\CFIE\cfie-postgres-password.dpapi"
$workspaceSecretPath = Join-Path $workspace ".atl-data\secrets\cfie-postgres-password.dpapi"
$secretPath = if (Test-Path -LiteralPath $defaultSecretPath) {
  $defaultSecretPath
} elseif (Test-Path -LiteralPath $profileSecretPath) {
  $profileSecretPath
} else {
  $workspaceSecretPath
}
if (-not (Test-Path -LiteralPath $secretPath)) { throw "Protected CFIE PostgreSQL credential is missing" }
$secure = ConvertTo-SecureString ((Get-Content -LiteralPath $secretPath -Raw).Trim())
$credential = [System.Management.Automation.PSCredential]::new($Role, $secure)
$password = $credential.GetNetworkCredential().Password

$pgDump = "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe"
if (-not (Test-Path -LiteralPath $pgDump)) { throw "PostgreSQL pg_dump was not found" }

$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$finalPath = Join-Path $backupRoot "cfie-$stamp.dump"
$temporaryPath = "$finalPath.partial"
$manifestPath = "$finalPath.json"
$previousPassword = $env:PGPASSWORD
try {
  $env:PGPASSWORD = $password
  & $pgDump --host=$HostName --port=$Port --username=$Role --dbname=$Database --format=custom --compress=6 --file=$temporaryPath
  if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }
} finally {
  if ($null -eq $previousPassword) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
  else { $env:PGPASSWORD = $previousPassword }
  $password = $null
}

if (-not (Test-Path -LiteralPath $temporaryPath)) { throw "Backup output was not created" }
Move-Item -LiteralPath $temporaryPath -Destination $finalPath
$file = Get-Item -LiteralPath $finalPath
$hash = (Get-FileHash -LiteralPath $finalPath -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = [ordered]@{
  authority = "READ_ONLY_DATABASE_BACKUP"
  database = $Database
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  backupPath = $finalPath
  bytes = $file.Length
  sha256 = $hash
  format = "POSTGRESQL_CUSTOM"
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8
$expired = @(Get-ChildItem -LiteralPath $backupRoot -Filter "cfie-*.dump" -File |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -Skip $MaximumBackups)
foreach ($expiredBackup in $expired) {
  $resolvedExpired = [System.IO.Path]::GetFullPath($expiredBackup.FullName)
  if (-not $resolvedExpired.StartsWith($backupRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to prune a backup outside the configured backup directory"
  }
  Remove-Item -LiteralPath $resolvedExpired
  $expiredManifest = "$resolvedExpired.json"
  if (Test-Path -LiteralPath $expiredManifest) { Remove-Item -LiteralPath $expiredManifest }
}
$manifest["retainedBackupCount"] = @(Get-ChildItem -LiteralPath $backupRoot -Filter "cfie-*.dump" -File).Count
$manifest["maximumBackups"] = $MaximumBackups
$manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8
$verifyScript = Join-Path $PSScriptRoot "verify-cfie-backup.ps1"
& $verifyScript -BackupDirectory $backupRoot -BackupPath $finalPath
if ($LASTEXITCODE -ne 0) { throw "Backup verification failed" }
$manifest | ConvertTo-Json
