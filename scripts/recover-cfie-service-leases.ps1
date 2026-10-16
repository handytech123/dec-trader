$ErrorActionPreference = "Stop"
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
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$databaseSecretPath = Join-Path $repositoryRoot ".atl-data\secrets\cfie-postgres-password.dpapi"
if (-not (Test-Path -LiteralPath $databaseSecretPath)) {
  throw "Protected CFIE PostgreSQL credential is missing"
}
$activeWorkers = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "node.exe" -and (
    $_.CommandLine -like "*dist/collect-service-cli.js*" -or
    $_.CommandLine -like "*dist/derive-service-cli.js*"
  )
})
if ($activeWorkers.Count -gt 0) {
  throw "Refusing lease recovery while CFIE worker processes are active"
}
$databasePassword = Read-CfieWindowsDpapiSecureString -SecretPath $databaseSecretPath
$encodedDatabasePassword = [System.Uri]::EscapeDataString($databasePassword)
$env:CFIE_DATABASE_URL = "postgresql://cfie_app:$encodedDatabasePassword@127.0.0.1:5432/cfie_research"
$databasePassword = $null
$encodedDatabasePassword = $null
try {
  Push-Location $repositoryRoot
  pnpm --filter @autonomous-trading-lab/ingestion operations:recover-leases -- --recover-supervisor-handoff
  if ($LASTEXITCODE -ne 0) { throw "CFIE lease recovery failed" }
} finally {
  Pop-Location
  $env:CFIE_DATABASE_URL = $null
}
