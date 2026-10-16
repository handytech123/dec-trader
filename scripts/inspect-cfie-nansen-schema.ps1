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

function Get-Shape($value) {
  if ($null -eq $value) { return "null" }
  if ($value -is [Array]) { return "array" }
  if ($value -is [pscustomobject]) { return "object" }
  return $value.GetType().Name
}

try {
  $body = @{ chains = @("solana"); pagination = @{ page = 1; per_page = 1 } } |
    ConvertTo-Json -Depth 4 -Compress
  $response = Invoke-RestMethod -UseBasicParsing -Method Post `
    -Uri "https://api.nansen.ai/api/v1/smart-money/holdings" `
    -Headers @{ apikey = $apiKey } -ContentType "application/json" -Body $body
  $topLevel = @($response.psobject.Properties | ForEach-Object {
    [ordered]@{ name = $_.Name; type = Get-Shape $_.Value }
  })
  $first = $null
  if ($response.data -is [Array] -and $response.data.Count -gt 0) { $first = $response.data[0] }
  $row = @()
  if ($null -ne $first) {
    $row = @($first.psobject.Properties | ForEach-Object {
      [ordered]@{ name = $_.Name; type = Get-Shape $_.Value }
    })
  }
  [ordered]@{
    authority = "READ_ONLY_SCHEMA_INSPECTION"
    provider = "nansen"
    endpoint = "smart-money/holdings"
    responseFields = $topLevel
    firstDataRowFields = $row
    dataRowCount = if ($response.data -is [Array]) { $response.data.Count } else { 0 }
    valuesRedacted = $true
  } | ConvertTo-Json -Depth 6
} finally {
  $apiKey = $null
  [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  [Array]::Clear($protectedBytes, 0, $protectedBytes.Length)
}
