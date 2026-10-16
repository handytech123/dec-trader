param(
  [ValidateRange(1, 10000)]
  [int]$MaximumDailyCredits = 125,
  [ValidateRange(1, 1000000)]
  [int]$MinimumEventCount = 100
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$workspaceProfile = if ($env:CFIE_PROFILE_ROOT) {
  $env:CFIE_PROFILE_ROOT
} else {
  Split-Path (Split-Path (Split-Path $repositoryRoot -Parent) -Parent) -Parent
}
$candidateSecretPaths = @(
  (Join-Path $env:LOCALAPPDATA "CFIE\nansen-api-key.dpapi"),
  (Join-Path $workspaceProfile "AppData\Local\CFIE\nansen-api-key.dpapi"),
  (Join-Path $repositoryRoot ".atl-data\secrets\nansen-api-key.dpapi")
)
$secretPath = $candidateSecretPaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $secretPath) { throw "Encrypted Nansen API key is not configured" }

$protectedBytes = [Convert]::FromBase64String((Get-Content -LiteralPath $secretPath -Raw).Trim())
$entropy = [System.Text.Encoding]::UTF8.GetBytes("CFIE:NANSEN:API_KEY:V1")
$plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $protectedBytes,
  $entropy,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
$env:NANSEN_API_KEY = [System.Text.Encoding]::UTF8.GetString($plainBytes)

$candidateDatabaseSecretPaths = @(
  (Join-Path $env:LOCALAPPDATA "CFIE\cfie-postgres-password.dpapi"),
  (Join-Path $workspaceProfile "AppData\Local\CFIE\cfie-postgres-password.dpapi"),
  (Join-Path $repositoryRoot ".atl-data\secrets\cfie-postgres-password.dpapi")
)
$databaseSecretPath = $candidateDatabaseSecretPaths |
  Where-Object { Test-Path -LiteralPath $_ } |
  Select-Object -First 1
if (-not $databaseSecretPath) { throw "Protected CFIE PostgreSQL credential is missing" }
$databaseSecret = ConvertTo-SecureString ((Get-Content -LiteralPath $databaseSecretPath -Raw).Trim())
$databaseCredential = [System.Management.Automation.PSCredential]::new("cfie_app", $databaseSecret)
$encodedPassword = [System.Uri]::EscapeDataString(
  $databaseCredential.GetNetworkCredential().Password
)
$env:CFIE_DATABASE_URL = "postgresql://cfie_app:$encodedPassword@127.0.0.1:5432/cfie_research"

try {
  Push-Location $repositoryRoot
  pnpm --filter @autonomous-trading-lab/ingestion enrichment:nansen-label-pilot -- `
    --bounded-nansen-label-pilot `
    --maximum-daily-credits $MaximumDailyCredits `
    --minimum-event-count $MinimumEventCount
  if ($LASTEXITCODE -ne 0) { throw "Nansen common-label pilot failed" }
} finally {
  Pop-Location
  $env:NANSEN_API_KEY = $null
  $env:CFIE_DATABASE_URL = $null
  $encodedPassword = $null
  [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  [Array]::Clear($protectedBytes, 0, $protectedBytes.Length)
}
