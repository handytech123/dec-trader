param(
  [int]$RestartDelaySeconds = 30,
  [int]$StorageWarningFreeGiB = 20,
  [int]$StorageCriticalFreeGiB = 5,
  [ValidateRange(50, 2000)]
  [int]$DatabasePauseFreeGiB = 100,
  [ValidateRange(10, 3600)]
  [int]$FilteredReconciliationIntervalSeconds = 30,
  [ValidateRange(1, 10000)]
  [int]$FilteredReconciliationBatchSize = 1000,
  [ValidateRange(1, 20)]
  [int]$FilteredReconciliationParallelBlocks = 4,
  [ValidateRange(1, 100)]
  [int]$NormalizationClaimBatchSize = 20,
  [ValidateRange(1, 32)]
  [int]$NormalizationParallelJobs = 8
)

$ErrorActionPreference = "Stop"
function Stop-CfieProcessTree([int]$TargetProcessId) {
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $TargetProcessId" -ErrorAction SilentlyContinue)
  foreach ($child in $children) {
    Stop-CfieProcessTree -TargetProcessId ([int]$child.ProcessId)
  }
  Stop-Process -Id $TargetProcessId -Force -ErrorAction SilentlyContinue
}
function Test-CfieProcess([object]$TargetProcess, [string]$CommandPattern) {
  if ($null -eq $TargetProcess) { return $false }
  try {
    $actual = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $TargetProcess.Id) -ErrorAction Stop
    return $null -ne $actual -and $actual.CommandLine -match $CommandPattern
  } catch {
    return $false
  }
}
function Write-CfieJsonAtomically([object]$Value, [string]$DestinationPath) {
  $destinationDirectory = Split-Path -Parent $DestinationPath
  $temporaryPath = Join-Path $destinationDirectory (".{0}.{1}.tmp" -f ([System.IO.Path]::GetFileName($DestinationPath)), [System.Guid]::NewGuid().ToString("N"))
  try {
    $Value | ConvertTo-Json | Set-Content -LiteralPath $temporaryPath -Encoding utf8
    Move-Item -LiteralPath $temporaryPath -Destination $DestinationPath -Force
  } finally {
    if (Test-Path -LiteralPath $temporaryPath) {
      Remove-Item -LiteralPath $temporaryPath -Force
    }
  }
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
if ($RestartDelaySeconds -lt 5 -or $RestartDelaySeconds -gt 3600) {
  throw "Restart delay must be between 5 and 3600 seconds"
}
if ($StorageCriticalFreeGiB -lt 1 -or $StorageWarningFreeGiB -le $StorageCriticalFreeGiB) {
  throw "Storage thresholds must be positive and warning must exceed critical"
}

$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtimeRoot = Join-Path $workspace ".atl-data\cfie-supervisor"
[System.IO.Directory]::CreateDirectory($runtimeRoot) | Out-Null
trap {
  $_ | Out-String | Set-Content -LiteralPath (Join-Path $runtimeRoot "supervisor-error.log") -Encoding utf8
  exit 1
}

$workspaceProfile = Split-Path (Split-Path (Split-Path $workspace -Parent) -Parent) -Parent
$env:CFIE_PROFILE_ROOT = $workspaceProfile
$defaultSecretPath = Join-Path $env:LOCALAPPDATA "CFIE\cfie-postgres-password.dpapi"
$profileSecretPath = Join-Path $workspaceProfile "AppData\Local\CFIE\cfie-postgres-password.dpapi"
$workspaceSecretPath = Join-Path $workspace ".atl-data\secrets\cfie-postgres-password.dpapi"
$secretPath = if (Test-Path -LiteralPath $defaultSecretPath) {
  $defaultSecretPath
} elseif (Test-Path -LiteralPath $profileSecretPath) {
  $profileSecretPath
} else {
  $workspaceSecretPath
}
if (-not (Test-Path -LiteralPath $secretPath)) {
  throw "Protected CFIE PostgreSQL credential is missing"
}
$password = Read-CfieWindowsDpapiSecureString -SecretPath $secretPath
$encodedPassword = [System.Uri]::EscapeDataString($password)
$env:CFIE_DATABASE_URL = "postgresql://cfie_app:$encodedPassword@127.0.0.1:5432/cfie_research"
$password = $null
$encodedPassword = $null
$profileHeliusSecretPath = Join-Path $workspaceProfile "AppData\Local\CFIE\helius-api-key.dpapi"
$workspaceHeliusSecretPath = Join-Path $workspace ".atl-data\secrets\helius-api-key.dpapi"
$heliusSecretPath = if (Test-Path -LiteralPath $profileHeliusSecretPath) {
  $profileHeliusSecretPath
} else {
  $workspaceHeliusSecretPath
}
if (-not (Test-Path -LiteralPath $heliusSecretPath)) {
  throw "Protected CFIE Helius credential is missing"
}
$solanaRpcProvider = "HELIUS"
$solanaRpcCredentialConfigured = $true
Add-Type -AssemblyName System.Security
$protectedHeliusKey = [Convert]::FromBase64String(
  (Get-Content -LiteralPath $heliusSecretPath -Raw).Trim()
)
$heliusEntropy = [System.Text.Encoding]::UTF8.GetBytes("CFIE:HELIUS:API_KEY:V1")
$heliusKeyBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $protectedHeliusKey,
  $heliusEntropy,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
try {
  $heliusKey = [System.Text.Encoding]::UTF8.GetString($heliusKeyBytes)
  $env:CFIE_SOLANA_RPC_URL = "https://mainnet.helius-rpc.com/?api-key=$heliusKey"
  $env:CFIE_SOLANA_WEBSOCKET_URL = "wss://atlas-mainnet.helius-rpc.com/?api-key=$heliusKey"
} finally {
  $heliusKey = $null
  [Array]::Clear($heliusKeyBytes, 0, $heliusKeyBytes.Length)
  [Array]::Clear($protectedHeliusKey, 0, $protectedHeliusKey.Length)
}
$env:ATL_DASHBOARD_HOST = "0.0.0.0"
$env:ATL_DASHBOARD_PORT = "4173"

$pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
$pnpm = if ($null -ne $pnpmCommand) {
  $pnpmCommand.Source
} else {
  Join-Path $env:APPDATA "npm\pnpm.cmd"
}
if (-not (Test-Path -LiteralPath $pnpm)) { throw "pnpm.cmd was not found for the CFIE supervisor" }
Push-Location $workspace
try {
  & $pnpm build
  if ($LASTEXITCODE -ne 0) { throw "CFIE build failed before supervisor startup" }

  $collector = $null
  $filteredCollector = $null
  $filteredReconciler = $null
  $deriver = $null
  $strategyBot = $null
  $dashboard = $null
  $research = $null
  $enrichment = $null
  $lastResearchStart = $null
  $lastEnrichmentStart = $null
  $lastFilteredReconciliationStart = $null
  $lastFilteredCollectorStart = $null
  $reconciliationBackpressureActive = $false
  $filteredCollectionBackpressureActive = $false
  $normalizationPending = $null
  $pendingFilteredReconciliations = $null
  $filteredStreamMarker = Join-Path $workspace ".atl-data\secrets\helius-enhanced-websocket.enabled"
  $filteredStreamEnabled = Test-Path -LiteralPath $filteredStreamMarker
  $previousStatusPath = Join-Path $runtimeRoot "status.json"
  if (Test-Path -LiteralPath $previousStatusPath) {
    try {
      $previousStatus = Get-Content -LiteralPath $previousStatusPath -Raw | ConvertFrom-Json
      if ($null -ne $previousStatus.lastEnrichmentStart) {
        $lastEnrichmentStart = [DateTime]::Parse($previousStatus.lastEnrichmentStart)
      }
      if ($null -ne $previousStatus.normalizationPending) {
        $normalizationPending = [int]$previousStatus.normalizationPending
        $reconciliationBackpressureActive = $normalizationPending -gt 10000
      }
    } catch {
      $lastEnrichmentStart = Get-Date
    }
  }
  $forecastBaselineFreeGiB = $null
  $forecastBaselineAt = $null
  $lastStorageDrainGiBPerDay = $null
  $lastEstimatedDaysToCritical = $null
  while ($true) {
    $observedAt = Get-Date
    $storagePaths = [ordered]@{
      workspace = $workspace
      database = "D:\CFIE\PostgreSQL\data"
      backups = "Z:\CFIE\backups"
    }
    $storageVolumes = @($storagePaths.GetEnumerator() | ForEach-Object {
      $volumeName = [System.IO.Path]::GetPathRoot([string]$_.Value).Substring(0, 1)
      $volume = Get-PSDrive -Name $volumeName -ErrorAction Stop
      [pscustomobject][ordered]@{
        purpose = $_.Key
        root = $volume.Root
        freeGiB = [math]::Round($volume.Free / 1GB, 2)
      }
    })
    $databaseFreeGiB = [double](($storageVolumes | Where-Object { $_.purpose -eq "database" } | Select-Object -First 1).freeGiB)
    $freeGiB = $databaseFreeGiB
    $storageDrainGiBPerDay = $lastStorageDrainGiBPerDay
    $estimatedDaysToCritical = $lastEstimatedDaysToCritical
    if ($null -eq $forecastBaselineFreeGiB -or $null -eq $forecastBaselineAt) {
      $forecastBaselineFreeGiB = $freeGiB
      $forecastBaselineAt = $observedAt
    } else {
      $elapsedDays = ($observedAt - $forecastBaselineAt).TotalDays
      if ($elapsedDays -ge (10 / 1440)) {
        $storageDrainGiBPerDay = [math]::Round([math]::Max(0, ($forecastBaselineFreeGiB - $freeGiB) / $elapsedDays), 2)
        if ($storageDrainGiBPerDay -gt 0) {
          $estimatedDaysToCritical = [math]::Round([math]::Max(0, ($freeGiB - $StorageCriticalFreeGiB) / $storageDrainGiBPerDay), 2)
        } else {
          $estimatedDaysToCritical = $null
        }
        $lastStorageDrainGiBPerDay = $storageDrainGiBPerDay
        $lastEstimatedDaysToCritical = $estimatedDaysToCritical
        $forecastBaselineFreeGiB = $freeGiB
        $forecastBaselineAt = $observedAt
      }
    }
    $storageStatus = if ($freeGiB -le $StorageCriticalFreeGiB) {
      "CRITICAL"
    } elseif ($freeGiB -le $StorageWarningFreeGiB) {
      "WARNING"
    } else {
      "HEALTHY"
    }
    $ingestionStoragePaused = $databaseFreeGiB -le $DatabasePauseFreeGiB
    try {
      $healthSnapshot = Invoke-RestMethod -Uri "http://127.0.0.1:$($env:ATL_DASHBOARD_PORT)/api/health" -TimeoutSec 5
      $normalizationPending = [int]$healthSnapshot.queue.pending
      $pendingFilteredReconciliations = [int]$healthSnapshot.pendingFilteredReconciliations
      if (-not $reconciliationBackpressureActive -and $normalizationPending -gt 10000) {
        $reconciliationBackpressureActive = $true
      } elseif ($reconciliationBackpressureActive -and $normalizationPending -le 5000) {
        $reconciliationBackpressureActive = $false
      }
      if (-not $filteredCollectionBackpressureActive -and $pendingFilteredReconciliations -gt 10000) {
        $filteredCollectionBackpressureActive = $true
      } elseif ($filteredCollectionBackpressureActive -and $pendingFilteredReconciliations -le 5000) {
        $filteredCollectionBackpressureActive = $false
      }
    } catch {
      $normalizationPending = $null
      $pendingFilteredReconciliations = $null
    }
    if ($ingestionStoragePaused -and (Test-CfieProcess $collector "ingestion collect:service")) {
      Stop-CfieProcessTree -TargetProcessId $collector.Id
    }
    if ($ingestionStoragePaused -and (Test-CfieProcess $filteredCollector "ingestion observe:filtered-solana")) {
      Stop-CfieProcessTree -TargetProcessId $filteredCollector.Id
    }
    if ($ingestionStoragePaused -and (Test-CfieProcess $deriver "ingestion derive:service")) {
      Stop-CfieProcessTree -TargetProcessId $deriver.Id
    }
    if (-not $ingestionStoragePaused -and -not (Test-CfieProcess $collector "ingestion collect:service")) {
      $collector = Start-Process -FilePath $pnpm -WindowStyle Hidden -PassThru -WorkingDirectory $workspace `
        -RedirectStandardOutput (Join-Path $runtimeRoot "collector.stdout.log") `
        -RedirectStandardError (Join-Path $runtimeRoot "collector.stderr.log") `
        -ArgumentList @(
          "--filter", "@autonomous-trading-lab/ingestion", "collect:service", "--",
          "--enable-read-only-service", "--output-directory", ".atl-data/cfie-service-postgres",
          "--external-derivation",
          "--coinbase-websocket", "wss://ws-feed.exchange.coinbase.com",
          "--coinbase-rest", "https://api.exchange.coinbase.com",
          "--coinbase-product", "SOL-USD", "--coinbase-basis-product", "USDT-USD",
          "--coinbase-benchmark-product", "BTC-USD",
          "--binance-websocket", "wss://stream.binance.us:9443",
          "--binance-rest", "https://api.binance.us", "--binance-symbol", "SOLUSDT",
          "--binance-venue", "binance-us-spot", "--max-runtime-seconds", "604800",
          "--segment-seconds", "3600", "--retention-days", "7",
          "--max-cycle-failures", "10", "--failure-backoff-seconds", "30",
          "--solana-poll-interval-ms", "1000", "--solana-rpc-min-request-interval-ms", "300",
          "--reference-interval-ms", "10000", "--max-reaction-events-per-window", "5",
          "--max-general-outcome-events-per-cycle", "0",
          "--max-general-benchmark-events-per-cycle", "0",
          "--reaction-snapshot-age-seconds", "60", "--solana-max-batch-slots", "5",
          "--solana-max-parallel-blocks", "1", "--solana-max-live-tail-lag-slots", "500",
          "--normalization-claim-batch-size", ([string]$NormalizationClaimBatchSize),
          "--normalization-max-parallel-jobs", ([string]$NormalizationParallelJobs)
        )
    }
    $filteredCollectorDue = $filteredStreamEnabled -and -not (
      Test-CfieProcess $filteredCollector "ingestion observe:filtered-solana"
    )
    if ($filteredCollectionBackpressureActive -and (Test-CfieProcess $filteredCollector "ingestion observe:filtered-solana")) {
      Stop-CfieProcessTree -TargetProcessId $filteredCollector.Id
    }
    if ($filteredCollectorDue -and -not $filteredCollectionBackpressureActive -and -not $ingestionStoragePaused -and -not (Test-CfieProcess $filteredCollector "ingestion observe:filtered-solana")) {
      $lastFilteredCollectorStart = $observedAt
      $filteredCollector = Start-Process -FilePath $pnpm -WindowStyle Hidden -PassThru -WorkingDirectory $workspace `
        -RedirectStandardOutput (Join-Path $runtimeRoot "filtered-collector.stdout.log") `
        -RedirectStandardError (Join-Path $runtimeRoot "filtered-collector.stderr.log") `
        -ArgumentList @(
          "--filter", "@autonomous-trading-lab/ingestion", "observe:filtered-solana", "--",
          "--enable-read-only-filtered-stream", "--database", ".atl-data/research-db",
          "--entity-manifest", "config/solana-filtered-stream.production.json",
          "--filter-id", "verified-entities-v1", "--max-duration-seconds", "3600",
          "--max-messages", "100000", "--max-bytes", "250000000", "--max-reconnects", "20"
        )
    }
    $filteredReconciliationDue = $filteredStreamEnabled -and (
      $null -eq $lastFilteredReconciliationStart -or
      (($observedAt - $lastFilteredReconciliationStart).TotalSeconds -ge $FilteredReconciliationIntervalSeconds)
    )
    if ($reconciliationBackpressureActive -and (Test-CfieProcess $filteredReconciler "ingestion reconcile:filtered-solana")) {
      Stop-CfieProcessTree -TargetProcessId $filteredReconciler.Id
    }
    if ($filteredReconciliationDue -and -not $reconciliationBackpressureActive -and -not $ingestionStoragePaused -and -not (Test-CfieProcess $filteredReconciler "ingestion reconcile:filtered-solana")) {
      $lastFilteredReconciliationStart = $observedAt
      $filteredReconciler = Start-Process -FilePath $pnpm -WindowStyle Hidden -PassThru -WorkingDirectory $workspace `
        -RedirectStandardOutput (Join-Path $runtimeRoot "filtered-reconciler.stdout.log") `
        -RedirectStandardError (Join-Path $runtimeRoot "filtered-reconciler.stderr.log") `
        -ArgumentList @(
          "--filter", "@autonomous-trading-lab/ingestion", "reconcile:filtered-solana", "--",
          "--enable-read-only-reconciliation", "--database", ".atl-data/research-db",
          "--limit", ([string]$FilteredReconciliationBatchSize),
          "--max-parallel-blocks", ([string]$FilteredReconciliationParallelBlocks)
        )
    }
    if (-not $ingestionStoragePaused -and -not (Test-CfieProcess $deriver "ingestion derive:service")) {
      $deriver = Start-Process -FilePath $pnpm -WindowStyle Hidden -PassThru -WorkingDirectory $workspace `
        -RedirectStandardOutput (Join-Path $runtimeRoot "deriver.stdout.log") `
        -RedirectStandardError (Join-Path $runtimeRoot "deriver.stderr.log") `
        -ArgumentList @(
          "--filter", "@autonomous-trading-lab/ingestion", "derive:service", "--",
          "--enable-read-only-derivation", "--output-directory", ".atl-data/cfie-service-postgres",
          "--interval-seconds", "300", "--maximum-owner-blocks", "25",
          "--paper-lab-interval-seconds", "3600",
          "--max-runtime-seconds", "604800"
        )
    }
    if ($storageStatus -ne "CRITICAL" -and -not (Test-CfieProcess $strategyBot "strategy-worker start")) {
      $strategyBot = Start-Process -FilePath $pnpm -WindowStyle Hidden -PassThru -WorkingDirectory $workspace `
        -RedirectStandardOutput (Join-Path $runtimeRoot "strategy-bot.stdout.log") `
        -RedirectStandardError (Join-Path $runtimeRoot "strategy-bot.stderr.log") `
        -ArgumentList @(
          "--filter", "@autonomous-trading-lab/strategy-worker", "start", "--",
          "--enable-paper-proposal-service", "--bridge-cfie-control", "--bridge-cfie-research",
          "--maximum-cycles", "604800", "--interval-seconds", "10"
        )
    }
    if (-not (Test-CfieProcess $dashboard "@autonomous-trading-lab/dashboard start")) {
      $dashboard = Start-Process -FilePath $pnpm -WindowStyle Hidden -PassThru -WorkingDirectory $workspace `
        -RedirectStandardOutput (Join-Path $runtimeRoot "dashboard.stdout.log") `
        -RedirectStandardError (Join-Path $runtimeRoot "dashboard.stderr.log") `
        -ArgumentList @("--filter", "@autonomous-trading-lab/dashboard", "start")
    }
    $researchDue = $null -eq $lastResearchStart -or (($observedAt - $lastResearchStart).TotalMinutes -ge 60)
    if ($researchDue -and -not (Test-CfieProcess $research "ingestion research:run")) {
      $lastResearchStart = $observedAt
      $research = Start-Process -FilePath $pnpm -WindowStyle Hidden -PassThru -WorkingDirectory $workspace `
        -RedirectStandardOutput (Join-Path $runtimeRoot "research.stdout.log") `
        -RedirectStandardError (Join-Path $runtimeRoot "research.stderr.log") `
        -ArgumentList @(
          "--filter", "@autonomous-trading-lab/ingestion", "research:run", "--",
          "--run-research", "--protocol-database", ".atl-data/research-db",
          "--protocol-id", "protocol_1AQAXYB54FTHFD8KSTXZZKB1XZ",
          "--family", "PROTOCOL_FLOW",
          "--output", "artifacts/research/pumpswap-development-latest.json"
        )
    }
    $enrichmentDue = $null -eq $lastEnrichmentStart -or (($observedAt - $lastEnrichmentStart).TotalMinutes -ge 60)
    if ($enrichmentDue -and -not (Test-CfieProcess $enrichment "run-cfie-nansen-enrichment\.ps1")) {
      $lastEnrichmentStart = $observedAt
      $enrichment = Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -PassThru -WorkingDirectory $workspace `
        -RedirectStandardOutput (Join-Path $runtimeRoot "enrichment.stdout.log") `
        -RedirectStandardError (Join-Path $runtimeRoot "enrichment.stderr.log") `
        -ArgumentList @(
          "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
          "scripts\run-cfie-nansen-enrichment.ps1"
        )
    }
    $status = [ordered]@{
      observedAt = $observedAt.ToUniversalTime().ToString("o")
      authority = "READ_ONLY_RESEARCH"
      solanaRpcProvider = $solanaRpcProvider
      solanaRpcCredentialConfigured = $solanaRpcCredentialConfigured
      storageStatus = $storageStatus
      storageFreeGiB = $freeGiB
      storageVolumes = $storageVolumes
      databaseFreeGiB = $databaseFreeGiB
      databasePauseFreeGiB = $DatabasePauseFreeGiB
      ingestionStoragePaused = $ingestionStoragePaused
      storageWarningFreeGiB = $StorageWarningFreeGiB
      storageCriticalFreeGiB = $StorageCriticalFreeGiB
      storageDrainGiBPerDay = $storageDrainGiBPerDay
      estimatedDaysToCritical = $estimatedDaysToCritical
      collectorPid = if ($null -eq $collector) { $null } else { $collector.Id }
      collectorRunning = Test-CfieProcess $collector "ingestion collect:service"
      filteredStreamEnabled = $filteredStreamEnabled
      filteredCollectorPid = if ($null -eq $filteredCollector) { $null } else { $filteredCollector.Id }
      filteredCollectorRunning = Test-CfieProcess $filteredCollector "ingestion observe:filtered-solana"
      lastFilteredCollectorStart = if ($null -eq $lastFilteredCollectorStart) { $null } else { $lastFilteredCollectorStart.ToUniversalTime().ToString("o") }
      filteredReconcilerPid = if ($null -eq $filteredReconciler) { $null } else { $filteredReconciler.Id }
      filteredReconcilerRunning = Test-CfieProcess $filteredReconciler "ingestion reconcile:filtered-solana"
      lastFilteredReconciliationStart = if ($null -eq $lastFilteredReconciliationStart) { $null } else { $lastFilteredReconciliationStart.ToUniversalTime().ToString("o") }
      filteredReconciliationIntervalSeconds = $FilteredReconciliationIntervalSeconds
      filteredReconciliationBatchSize = $FilteredReconciliationBatchSize
      filteredReconciliationParallelBlocks = $FilteredReconciliationParallelBlocks
      normalizationClaimBatchSize = $NormalizationClaimBatchSize
      normalizationParallelJobs = $NormalizationParallelJobs
      normalizationPending = $normalizationPending
      reconciliationBackpressureActive = $reconciliationBackpressureActive
      reconciliationResumePendingThreshold = 5000
      pendingFilteredReconciliations = $pendingFilteredReconciliations
      filteredCollectionBackpressureActive = $filteredCollectionBackpressureActive
      filteredCollectionResumePendingThreshold = 5000
      deriverPid = if ($null -eq $deriver) { $null } else { $deriver.Id }
      deriverRunning = Test-CfieProcess $deriver "ingestion derive:service"
      strategyBotPid = if ($null -eq $strategyBot) { $null } else { $strategyBot.Id }
      strategyBotRunning = Test-CfieProcess $strategyBot "strategy-worker start"
      dashboardPid = $dashboard.Id
      dashboardRunning = Test-CfieProcess $dashboard "@autonomous-trading-lab/dashboard start"
      researchPid = if ($null -eq $research) { $null } else { $research.Id }
      researchRunning = Test-CfieProcess $research "ingestion research:run"
      lastResearchStart = if ($null -eq $lastResearchStart) { $null } else { $lastResearchStart.ToUniversalTime().ToString("o") }
      enrichmentPid = if ($null -eq $enrichment) { $null } else { $enrichment.Id }
      enrichmentRunning = Test-CfieProcess $enrichment "run-cfie-nansen-enrichment\.ps1"
      lastEnrichmentStart = if ($null -eq $lastEnrichmentStart) { $null } else { $lastEnrichmentStart.ToUniversalTime().ToString("o") }
    }
    Write-CfieJsonAtomically -Value $status -DestinationPath (Join-Path $runtimeRoot "status.json")
    Start-Sleep -Seconds $RestartDelaySeconds
  }
} catch {
  $_ | Out-String | Set-Content -LiteralPath (Join-Path $runtimeRoot "supervisor-error.log") -Encoding utf8
  throw
} finally {
  $managedProcesses = @(
    @{ Process = $collector; Pattern = "ingestion collect:service" },
    @{ Process = $filteredCollector; Pattern = "ingestion observe:filtered-solana" },
    @{ Process = $filteredReconciler; Pattern = "ingestion reconcile:filtered-solana" },
    @{ Process = $deriver; Pattern = "ingestion derive:service" },
    @{ Process = $strategyBot; Pattern = "strategy-worker start" },
    @{ Process = $dashboard; Pattern = "@autonomous-trading-lab/dashboard start" },
    @{ Process = $research; Pattern = "ingestion research:run" },
    @{ Process = $enrichment; Pattern = "run-cfie-nansen-enrichment\.ps1" }
  )
  foreach ($managed in $managedProcesses) {
    if (Test-CfieProcess $managed.Process $managed.Pattern) {
      Stop-CfieProcessTree -TargetProcessId $managed.Process.Id
    }
  }
  Pop-Location
  Remove-Item Env:CFIE_DATABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:CFIE_PROFILE_ROOT -ErrorAction SilentlyContinue
  Remove-Item Env:CFIE_SOLANA_RPC_URL -ErrorAction SilentlyContinue
  Remove-Item Env:CFIE_SOLANA_WEBSOCKET_URL -ErrorAction SilentlyContinue
}
