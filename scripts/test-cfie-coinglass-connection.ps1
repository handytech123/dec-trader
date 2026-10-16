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
$apiKey = [System.Text.Encoding]::UTF8.GetString($plainBytes)
try {
  $response = Invoke-WebRequest -UseBasicParsing -Method Get `
    -Uri "https://open-api-v4.coinglass.com/api/futures/open-interest/exchange-list?symbol=SOL" `
    -Headers @{ "CG-API-KEY" = $apiKey; accept = "application/json" }
  [pscustomobject]@{
    Authority = "READ_ONLY_PROVIDER_VALIDATION"
    Provider = "coinglass"
    Endpoint = "futures/open-interest/exchange-list"
    Symbol = "SOL"
    HttpStatus = [int]$response.StatusCode
    Authenticated = ([int]$response.StatusCode -eq 200)
    ValidatedAt = [DateTime]::UtcNow.ToString("o")
  } | ConvertTo-Json
} catch {
  $status = $null
  if ($null -ne $_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
  [pscustomobject]@{
    Authority = "READ_ONLY_PROVIDER_VALIDATION"
    Provider = "coinglass"
    Endpoint = "futures/open-interest/exchange-list"
    Symbol = "SOL"
    HttpStatus = $status
    Authenticated = $false
    ErrorType = $_.Exception.GetType().Name
    ValidatedAt = [DateTime]::UtcNow.ToString("o")
  } | ConvertTo-Json
  exit 1
} finally {
  $apiKey = $null
  [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  [Array]::Clear($protectedBytes, 0, $protectedBytes.Length)
}
