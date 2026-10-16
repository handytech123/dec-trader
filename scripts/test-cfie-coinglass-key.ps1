$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$secretPath = Join-Path $env:LOCALAPPDATA "CFIE\coinglass-api-key.dpapi"
if (-not (Test-Path -LiteralPath $secretPath)) {
  throw "Encrypted CoinGlass API key is not configured"
}
$protectedBytes = [Convert]::FromBase64String((Get-Content -LiteralPath $secretPath -Raw).Trim())
$entropy = [System.Text.Encoding]::UTF8.GetBytes("CFIE:COINGLASS:API_KEY:V1")
$plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $protectedBytes,
  $entropy,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
try {
  if ($plainBytes.Length -eq 0) { throw "Decrypted CoinGlass API key is empty" }
  Write-Host "CoinGlass API key is present and decryptable for the current Windows user."
} finally {
  [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  [Array]::Clear($protectedBytes, 0, $protectedBytes.Length)
}
