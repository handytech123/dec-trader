param([string]$OutputDirectory = "artifacts/validation")

$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $workspace $OutputDirectory))
$workspacePrefix = $workspace.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $outputRoot.StartsWith($workspacePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Validation package must remain inside the workspace"
}
[System.IO.Directory]::CreateDirectory($outputRoot) | Out-Null

$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$staging = Join-Path ([System.IO.Path]::GetTempPath()) "cfie-validation-$stamp-$PID"
$packageRoot = Join-Path $staging "cfie-source"
[System.IO.Directory]::CreateDirectory($packageRoot) | Out-Null
try {
  $excludedDirectories = @(
    ".git", ".atl-data", ".codex-remote-attachments", "node_modules", "dist", "coverage",
    "artifacts", "crypto-eval-review"
  )
  $excludedExtensions = @(".dump", ".zip", ".log", ".dpapi")
  $files = Get-ChildItem -LiteralPath $workspace -File -Recurse | Where-Object {
    $relative = $_.FullName.Substring($workspacePrefix.Length)
    $segments = $relative -split '[\\/]'
    -not ($segments | Where-Object { $excludedDirectories -contains $_ }) -and
      -not ($excludedExtensions -contains $_.Extension.ToLowerInvariant()) -and
      $_.Name -notmatch '^\.env($|\.)'
  }
  $manifestFiles = @()
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($workspacePrefix.Length)
    $destination = Join-Path $packageRoot $relative
    [System.IO.Directory]::CreateDirectory((Split-Path $destination -Parent)) | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $destination
    $manifestFiles += [ordered]@{
      path = $relative.Replace('\', '/')
      bytes = $file.Length
      sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  $manifest = [ordered]@{
    package = "CFIE external validation source"
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    authority = "READ_ONLY_RESEARCH; NO_ORDER_EXECUTION"
    secretPolicy = "Secrets, live data, logs, dumps, build outputs, and local attachments are excluded."
    fileCount = $manifestFiles.Count
    files = $manifestFiles
  }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $packageRoot "VALIDATION-MANIFEST.json") -Encoding utf8
  $zipPath = Join-Path $outputRoot "cfie-source-validation-$stamp.zip"
  Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal
  [ordered]@{
    authority = "READ_ONLY_SOURCE_EXPORT"
    packagePath = $zipPath
    bytes = (Get-Item -LiteralPath $zipPath).Length
    sha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    fileCount = $manifestFiles.Count
  } | ConvertTo-Json
} finally {
  if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
  }
}
