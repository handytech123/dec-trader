param(
  [int]$ValidationSeconds = 15
)

$ErrorActionPreference = "Stop"
if ($ValidationSeconds -lt 5 -or $ValidationSeconds -gt 60) {
  throw "ValidationSeconds must be between 5 and 60"
}

function Read-CfieWindowsDpapiSecureString([string]$SecretPath) {
  Add-Type -AssemblyName System.Security
  $serialized = (Get-Content -LiteralPath $SecretPath -Raw).Trim()
  if ($serialized.Length -eq 0 -or ($serialized.Length % 2) -ne 0 -or $serialized -notmatch '^[0-9a-fA-F]+$') {
    throw "Protected CFIE credential has an invalid format"
  }
  $protectedBytes = [byte[]]::new($serialized.Length / 2)
  for ($index = 0; $index -lt $protectedBytes.Length; $index++) {
    $protectedBytes[$index] = [Convert]::ToByte($serialized.Substring($index * 2, 2), 16)
  }
  $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $protectedBytes,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  try {
    return [System.Text.Encoding]::Unicode.GetString($plainBytes)
  } finally {
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    [Array]::Clear($protectedBytes, 0, $protectedBytes.Length)
  }
}

$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$secretDirectory = Join-Path $env:LOCALAPPDATA "CFIE"
$databaseSecretPath = Join-Path $workspace ".atl-data\secrets\cfie-postgres-password.dpapi"
$heliusSecretPath = Join-Path $workspace ".atl-data\secrets\helius-api-key.dpapi"
$markerPath = Join-Path $workspace ".atl-data\secrets\helius-enhanced-websocket.enabled"
if (-not (Test-Path -LiteralPath $databaseSecretPath)) { throw "Protected PostgreSQL credential is missing" }
if (-not (Test-Path -LiteralPath $heliusSecretPath)) { throw "Protected Helius credential is missing" }

Add-Type -AssemblyName System.Security
$databasePassword = Read-CfieWindowsDpapiSecureString -SecretPath $databaseSecretPath
$protectedHeliusKey = [Convert]::FromBase64String(
  (Get-Content -LiteralPath $heliusSecretPath -Raw).Trim()
)
$entropy = [System.Text.Encoding]::UTF8.GetBytes("CFIE:HELIUS:API_KEY:V1")
$heliusKeyBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $protectedHeliusKey,
  $entropy,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
try {
  $heliusKey = [System.Text.Encoding]::UTF8.GetString($heliusKeyBytes)
  $env:CFIE_DATABASE_URL = "postgresql://cfie_app:$([Uri]::EscapeDataString($databasePassword))@127.0.0.1:5432/cfie_research"
  $env:CFIE_SOLANA_WEBSOCKET_URL = "wss://atlas-mainnet.helius-rpc.com/?api-key=$heliusKey"
  Push-Location $workspace
  try {
    Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue
    pnpm --filter @autonomous-trading-lab/ingestion observe:filtered-solana -- `
      --enable-read-only-filtered-stream --database .atl-data/research-db `
      --entity-manifest config/solana-filtered-stream.production.json --filter-id verified-entities-v1 `
      --max-duration-seconds $ValidationSeconds --max-messages 25 --max-bytes 10000000 --max-reconnects 0
    if ($LASTEXITCODE -ne 0) {
      throw "Helius rejected or failed the bounded filtered-stream validation; activation was not changed"
    }
  } finally {
    Pop-Location
  }
  [System.IO.Directory]::CreateDirectory($secretDirectory) | Out-Null
  Set-Content -LiteralPath $markerPath -Value "validated" -Encoding ascii -NoNewline
  Write-Output "CFIE Helius filtered stream validated and enabled. Restart the CFIE supervisor to activate it."
} finally {
  $databasePassword = $null
  $heliusKey = $null
  $env:CFIE_DATABASE_URL = $null
  $env:CFIE_SOLANA_WEBSOCKET_URL = $null
  [Array]::Clear($heliusKeyBytes, 0, $heliusKeyBytes.Length)
  [Array]::Clear($protectedHeliusKey, 0, $protectedHeliusKey.Length)
}
