param(
  [string]$Source = "C:\Program Files\PostgreSQL\17\data",
  [string]$Destination = "D:\CFIE\PostgreSQL\data"
)

$ErrorActionPreference = "Stop"
$serviceName = "postgresql-x64-17"
$taskName = "CFIE Read-Only Supervisor"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$logPath = Join-Path $workspace ".atl-data\cfie-supervisor\postgres-relocation.log"

function Write-RelocationLog([string]$Message) {
  $line = "{0} {1}" -f ([DateTime]::UtcNow.ToString("o")), $Message
  Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
  Write-Host $line
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"{0}"' -f $PSCommandPath),
    "-Source", ('"{0}"' -f $Source),
    "-Destination", ('"{0}"' -f $Destination)
  )
  Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $arguments
  exit 0
}

if ($Source -ne "C:\Program Files\PostgreSQL\17\data") {
  throw "Refusing unexpected PostgreSQL source path: $Source"
}
if ($Destination -ne "D:\CFIE\PostgreSQL\data") {
  throw "Refusing unexpected PostgreSQL destination path: $Destination"
}
if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
  throw "PostgreSQL source directory is missing: $Source"
}
if ((Get-Item -LiteralPath $Source).LinkType) {
  Write-RelocationLog "PostgreSQL data is already linked to D; nothing to move."
  exit 0
}

$destinationParent = Split-Path -Parent $Destination
[System.IO.Directory]::CreateDirectory($destinationParent) | Out-Null
$staleArchive = "{0}-stale-{1}" -f $Destination, ([DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ"))
$moved = $false

try {
  Write-RelocationLog "Stopping CFIE supervisor."
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq "node.exe" -and
      $_.CommandLine -match '^node\s+dist/(collect-service-cli|derive-service-cli|server)\.js'
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  Write-RelocationLog "Stopping PostgreSQL service."
  Stop-Service -Name $serviceName -Force
  (Get-Service -Name $serviceName).WaitForStatus("Stopped", [TimeSpan]::FromSeconds(60))

  if (Test-Path -LiteralPath $Destination) {
    Write-RelocationLog "Archiving stale D copy to $staleArchive."
    Move-Item -LiteralPath $Destination -Destination $staleArchive
  }

  Write-RelocationLog "Moving live PostgreSQL data to D."
  Move-Item -LiteralPath $Source -Destination $Destination
  $moved = $true
  New-Item -ItemType Junction -Path $Source -Target $Destination | Out-Null

  Write-RelocationLog "Starting PostgreSQL service."
  Start-Service -Name $serviceName
  (Get-Service -Name $serviceName).WaitForStatus("Running", [TimeSpan]::FromSeconds(60))

  $ready = & "C:\Program Files\PostgreSQL\17\bin\pg_isready.exe" -h 127.0.0.1 -p 5432
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL readiness check failed: $ready" }
  Write-RelocationLog "PostgreSQL relocation verified: $ready"

  Start-ScheduledTask -TaskName $taskName
  Write-RelocationLog "CFIE supervisor restarted. Relocation complete."
} catch {
  Write-RelocationLog ("Relocation failed: {0}" -f $_.Exception.Message)
  if ((Get-Service -Name $serviceName).Status -ne "Running") {
    if ($moved -and -not (Test-Path -LiteralPath $Source)) {
      Move-Item -LiteralPath $Destination -Destination $Source
      $moved = $false
    }
    Start-Service -Name $serviceName -ErrorAction SilentlyContinue
  }
  Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  throw
}
