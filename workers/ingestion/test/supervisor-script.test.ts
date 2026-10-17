import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Windows supervisor process identity", () => {
  it("validates command identity instead of trusting reusable process ids", async () => {
    // The repository test runner fixes process.cwd() to the workspace root.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const script = await readFile(
      resolve(process.cwd(), "scripts/run-cfie-supervisor.ps1"),
      "utf8",
    );
    expect(script).toContain("function Test-CfieProcess");
    expect(script).toContain("Get-CimInstance Win32_Process");
    expect(script).toContain("$actual.CommandLine -match $CommandPattern");
    expect(script).not.toContain(".HasExited");
  });

  it("decrypts the PostgreSQL credential without PowerShell module autoloading", async () => {
    // The repository test runner fixes process.cwd() to the workspace root.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const script = await readFile(
      resolve(process.cwd(), "scripts/run-cfie-supervisor.ps1"),
      "utf8",
    );
    expect(script).toContain("function Read-CfieWindowsDpapiSecureString");
    expect(script).toContain("[System.Security.Cryptography.ProtectedData]::Unprotect");
    expect(script).not.toContain("ConvertTo-SecureString");
  });

  it("monitors workspace, PostgreSQL, and backup volumes", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const script = await readFile(
      resolve(process.cwd(), "scripts/run-cfie-supervisor.ps1"),
      "utf8",
    );
    expect(script).toContain('database = "D:\\CFIE\\PostgreSQL\\data"');
    expect(script).toContain('backups = "Z:\\CFIE\\backups"');
    expect(script).toContain("storageVolumes = $storageVolumes");
    expect(script).toContain("Measure-Object -Property freeGiB -Minimum");
  });

  it("starts the metered filtered stream only after bounded validation", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const script = await readFile(
      resolve(process.cwd(), "scripts/run-cfie-supervisor.ps1"),
      "utf8",
    );
    expect(script).toContain("helius-enhanced-websocket.enabled");
    expect(script).toContain(
      '$filteredCollectorDue -and -not $filteredCollectionBackpressureActive -and $storageStatus -ne "CRITICAL"',
    );
    expect(script).toContain("$filteredCollectorDue = $filteredStreamEnabled -and -not (");
    expect(script).toContain('"--max-bytes", "250000000"');
    expect(script).toContain(
      '"--entity-manifest", "config/solana-filtered-stream.production.json"',
    );
    expect(script).toContain('"reconcile:filtered-solana"');
    expect(script).toContain("$FilteredReconciliationIntervalSeconds");
    expect(script).toContain("$FilteredReconciliationBatchSize");
    expect(script).toContain("$FilteredReconciliationParallelBlocks");
    expect(script).toContain(
      "$filteredReconciliationDue -and -not $reconciliationBackpressureActive",
    );
    expect(script).toContain("$NormalizationClaimBatchSize");
    expect(script).toContain("$NormalizationParallelJobs");
    expect(script).toContain("$reconciliationBackpressureActive");
    expect(script).toContain("$normalizationPending -gt 10000");
    expect(script).toContain("$normalizationPending -le 5000");
    expect(script).toContain("$filteredCollectionBackpressureActive");
    expect(script).toContain("$pendingFilteredReconciliations -gt 10000");
    expect(script).toContain("$pendingFilteredReconciliations -le 5000");
    expect(script).toContain(
      "$filteredCollectorDue -and -not $filteredCollectionBackpressureActive",
    );
  });
});

describe("Windows PostgreSQL backup safety", () => {
  it("verifies the created backup in its resolved output directory", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const script = await readFile(
      resolve(process.cwd(), "scripts/backup-cfie-postgres.ps1"),
      "utf8",
    );
    expect(script).toContain("-BackupDirectory $backupRoot -BackupPath $finalPath");
    expect(script).not.toContain("-BackupDirectory $BackupDirectory");
  });

  it("keeps the newest verified backup while pruning for capacity", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const script = await readFile(
      resolve(process.cwd(), "scripts/backup-cfie-postgres.ps1"),
      "utf8",
    );
    expect(script).toContain("latest-verification.json");
    expect(script).toContain("Select-Object -Skip 1");
    expect(script).toContain("newest complete backup is not verified");
    expect(script).toContain('[string]$OutputDirectory = "Z:\\CFIE\\backups"');
    expect(script).toContain('$approvedExternalRoot = "Z:\\CFIE\\backups"');
  });
});
