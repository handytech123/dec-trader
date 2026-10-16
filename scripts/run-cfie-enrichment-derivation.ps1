$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$databaseSecretPath = Join-Path $repositoryRoot ".atl-data\secrets\cfie-postgres-password.dpapi"
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
  pnpm --filter @autonomous-trading-lab/ingestion enrichment:features -- --derive-nansen-features
  if ($LASTEXITCODE -ne 0) { throw "Nansen feature derivation failed" }
  pnpm --filter @autonomous-trading-lab/ingestion enrichment:ablation -- --development-only
  if ($LASTEXITCODE -ne 0) { throw "Nansen enrichment ablation readiness check failed" }
  pnpm --filter @autonomous-trading-lab/ingestion enrichment:evaluate -- --development-only --if-ready --output artifacts/research/nansen-incremental-value-latest.json
  if ($LASTEXITCODE -ne 0) { throw "Nansen incremental-value evaluation failed" }
} finally {
  Pop-Location
  $env:CFIE_DATABASE_URL = $null
}
