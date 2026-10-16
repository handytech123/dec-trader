$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security

$secretPath = Join-Path $env:LOCALAPPDATA "CFIE\nansen-api-key.dpapi"
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
$apiKey = [System.Text.Encoding]::UTF8.GetString($plainBytes)
try {
  $body = @{ chains = @("solana"); pagination = @{ page = 1; per_page = 1 } } |
    ConvertTo-Json -Depth 4 -Compress
  $response = Invoke-WebRequest -UseBasicParsing -Method Post `
    -Uri "https://api.nansen.ai/api/v1/smart-money/holdings" `
    -Headers @{ apikey = $apiKey } -ContentType "application/json" -Body $body
  [pscustomobject]@{
    Authority = "READ_ONLY_PROVIDER_VALIDATION"
    Provider = "nansen"
    Endpoint = "smart-money/holdings"
    Chain = "solana"
    HttpStatus = [int]$response.StatusCode
    Authenticated = ([int]$response.StatusCode -eq 200)
    ValidatedAt = [DateTime]::UtcNow.ToString("o")
  } | ConvertTo-Json
} catch {
  $status = $null
  if ($null -ne $_.Exception.Response) {
    $status = [int]$_.Exception.Response.StatusCode
  }
  [pscustomobject]@{
    Authority = "READ_ONLY_PROVIDER_VALIDATION"
    Provider = "nansen"
    Endpoint = "smart-money/holdings"
    Chain = "solana"
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
