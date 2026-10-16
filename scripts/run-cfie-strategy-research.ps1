param(
  [ValidateRange(1, 1000)]
  [int]$MaximumCycles = 1,
  [ValidateRange(1, 3600)]
  [int]$IntervalSeconds = 10
)

$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$workspaceProfile = Split-Path (Split-Path (Split-Path $workspace -Parent) -Parent) -Parent
$candidateSecretPaths = @(
  (Join-Path $env:LOCALAPPDATA "CFIE\cfie-postgres-password.dpapi"),
  (Join-Path $workspaceProfile "AppData\Local\CFIE\cfie-postgres-password.dpapi"),
  (Join-Path $workspace ".atl-data\secrets\cfie-postgres-password.dpapi")
)
$secretPath = $candidateSecretPaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($null -eq $secretPath) { throw "Protected CFIE PostgreSQL credential is missing" }

Add-Type -AssemblyName System.Security
$serialized = (Get-Content -LiteralPath $secretPath -Raw).Trim()
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
  $password = [System.Text.Encoding]::Unicode.GetString($plainBytes)
  $encodedPassword = [System.Uri]::EscapeDataString($password)
  $env:CFIE_DATABASE_URL = "postgresql://cfie_app:$encodedPassword@127.0.0.1:5432/cfie_research"
  $password = $null
  $encodedPassword = $null

  Push-Location $workspace
  try {
    & pnpm.cmd --filter "@autonomous-trading-lab/strategy-worker" start -- `
      --enable-paper-proposal-service --bridge-cfie-research `
      --maximum-cycles $MaximumCycles --interval-seconds $IntervalSeconds
    if ($LASTEXITCODE -ne 0) { throw "CFIE research strategy cycle failed" }
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item Env:CFIE_DATABASE_URL -ErrorAction SilentlyContinue
  if ($null -ne $plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
  if ($null -ne $protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
}
