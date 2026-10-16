$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$workspaceProfile = if ($env:CFIE_PROFILE_ROOT) {
  $env:CFIE_PROFILE_ROOT
} else {
  Split-Path (Split-Path (Split-Path $repositoryRoot -Parent) -Parent) -Parent
}
$defaultNansenSecretPath = Join-Path $env:LOCALAPPDATA "CFIE\nansen-api-key.dpapi"
$profileNansenSecretPath = Join-Path $workspaceProfile "AppData\Local\CFIE\nansen-api-key.dpapi"
$workspaceNansenSecretPath = Join-Path $repositoryRoot ".atl-data\secrets\nansen-api-key.dpapi"
$secretPath = if (Test-Path -LiteralPath $defaultNansenSecretPath) {
  $defaultNansenSecretPath
} elseif (Test-Path -LiteralPath $profileNansenSecretPath) {
  $profileNansenSecretPath
} else {
  $workspaceNansenSecretPath
}
if (-not (Test-Path -LiteralPath $secretPath)) {
  throw "Encrypted Nansen API key is not configured"
}

$protectedBytes = [Convert]::FromBase64String((Get-Content -LiteralPath $secretPath -Raw).Trim())
$entropy = [System.Text.Encoding]::UTF8.GetBytes("CFIE:NANSEN:API_KEY:V1")
$plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $protectedBytes,
  $entropy,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
$env:NANSEN_API_KEY = [System.Text.Encoding]::UTF8.GetString($plainBytes)
$defaultDatabaseSecretPath = Join-Path $env:LOCALAPPDATA "CFIE\cfie-postgres-password.dpapi"
$profileDatabaseSecretPath = Join-Path $workspaceProfile "AppData\Local\CFIE\cfie-postgres-password.dpapi"
$workspaceDatabaseSecretPath = Join-Path $repositoryRoot ".atl-data\secrets\cfie-postgres-password.dpapi"
$databaseSecretPath = if (Test-Path -LiteralPath $defaultDatabaseSecretPath) {
  $defaultDatabaseSecretPath
} elseif (Test-Path -LiteralPath $profileDatabaseSecretPath) {
  $profileDatabaseSecretPath
} else {
  $workspaceDatabaseSecretPath
}
if (-not (Test-Path -LiteralPath $databaseSecretPath)) {
  throw "Protected CFIE PostgreSQL credential is missing"
}
$databaseSecret = ConvertTo-SecureString (
  (Get-Content -LiteralPath $databaseSecretPath -Raw).Trim()
)
$databaseCredential = [System.Management.Automation.PSCredential]::new(
  "cfie_app",
  $databaseSecret
)
$databasePassword = $databaseCredential.GetNetworkCredential().Password
$encodedDatabasePassword = [System.Uri]::EscapeDataString($databasePassword)
$env:CFIE_DATABASE_URL = "postgresql://cfie_app:$encodedDatabasePassword@127.0.0.1:5432/cfie_research"
$databasePassword = $null
$encodedDatabasePassword = $null
try {
  Push-Location $repositoryRoot
  pnpm --filter @autonomous-trading-lab/ingestion enrichment:pilot -- --bounded-enrichment-pilot
  if ($LASTEXITCODE -ne 0) { throw "Nansen enrichment pilot failed" }
  pnpm --filter @autonomous-trading-lab/ingestion enrichment:features -- --derive-nansen-features
  if ($LASTEXITCODE -ne 0) { throw "Nansen feature derivation failed" }
  pnpm --filter @autonomous-trading-lab/ingestion enrichment:ablation -- --development-only
  if ($LASTEXITCODE -ne 0) { throw "Nansen enrichment ablation readiness check failed" }
  pnpm --filter @autonomous-trading-lab/ingestion enrichment:evaluate -- --development-only --if-ready --output artifacts/research/nansen-incremental-value-latest.json
  if ($LASTEXITCODE -ne 0) { throw "Nansen incremental-value evaluation failed" }
} finally {
  Pop-Location
  $env:NANSEN_API_KEY = $null
  $env:CFIE_DATABASE_URL = $null
  [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  [Array]::Clear($protectedBytes, 0, $protectedBytes.Length)
}
