param(
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$secretDirectory = Join-Path $env:LOCALAPPDATA "CFIE"
$secretPath = Join-Path $secretDirectory "nansen-api-key.dpapi"

if ($Remove) {
  if (Test-Path -LiteralPath $secretPath) {
    Remove-Item -LiteralPath $secretPath -Force
    Write-Host "Encrypted Nansen API key removed."
  } else {
    Write-Host "No encrypted Nansen API key was stored."
  }
  exit 0
}

[System.IO.Directory]::CreateDirectory($secretDirectory) | Out-Null
$secureKey = Read-Host "Paste the Nansen API key (input is hidden)" -AsSecureString
$encrypted = ConvertFrom-SecureString $secureKey
if ([string]::IsNullOrWhiteSpace($encrypted)) {
  throw "Nansen API key was empty"
}
Set-Content -LiteralPath $secretPath -Value $encrypted -Encoding utf8 -NoNewline

$acl = Get-Acl -LiteralPath $secretPath
$acl.SetAccessRuleProtection($true, $false)
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $identity,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $secretPath -AclObject $acl

Write-Host "Nansen API key encrypted for the current Windows user."
Write-Host "Stored outside Git at: $secretPath"
