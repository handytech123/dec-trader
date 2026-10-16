import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ResearchDatabase } from "./database.js";
import { databaseLocation } from "./database-location.js";
import { deterministicDomainId } from "./ids.js";
import { matureMarketReactions } from "./market-reaction-worker.js";
import { runOwnerExtractionBatch } from "./owner-extraction-worker.js";
import { shouldRefreshEntityRollup } from "./derivation-policy.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function integerOption(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be between ${String(minimum)} and ${String(maximum)}`);
  return value;
}
const delay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolveDelay();
      },
      { once: true },
    );
  });
async function writeManifest(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  // Fixed path under the explicitly selected output directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await rename(temporary, path);
}

async function main(): Promise<void> {
  if (!process.argv.includes("--enable-read-only-derivation"))
    throw new Error("derivation service requires --enable-read-only-derivation");
  const root = process.env.INIT_CWD ?? process.cwd();
  const outputDirectory = resolve(root, requiredOption("--output-directory"));
  // Explicit CLI output directory is resolved before use.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(outputDirectory, { recursive: true });
  const databasePath = databaseLocation(
    root,
    process.env.CFIE_DATABASE_URL ??
      option("--database") ??
      resolve(outputDirectory, "research-db"),
  );
  const intervalSeconds = integerOption("--interval-seconds", 30, 10, 3600);
  const maximumRuntimeSeconds = integerOption("--max-runtime-seconds", 604800, 60, 604800);
  const maximumOwnerBlocks = integerOption("--maximum-owner-blocks", 25, 1, 1000);
  const paperLabIntervalSeconds = integerOption("--paper-lab-interval-seconds", 3600, 300, 86_400);
  const serviceName = option("--service-name") ?? "cfie-primary-deriver";
  const ownerId = randomUUID();
  const startedAt = new Date();
  const deadlineAt = new Date(startedAt.getTime() + maximumRuntimeSeconds * 1000);
  const manifestPath = resolve(outputDirectory, "derivation-service.json");
  const shutdown = new AbortController();
  process.once("SIGINT", () => {
    shutdown.abort();
  });
  process.once("SIGTERM", () => {
    shutdown.abort();
  });
  const deadline = setTimeout(() => {
    shutdown.abort();
  }, maximumRuntimeSeconds * 1000);
  const database = new ResearchDatabase(databasePath);
  let leaseAcquired = false;
  let completedCycles = 0;
  let ownerExtractionCompletionRollupPerformed = false;
  let lastPaperLabAt: Date | undefined;
  try {
    await database.migrate(resolve(root, "infra/postgres/migrations"));
    const now = new Date();
    const leaseMs = 300_000;
    leaseAcquired = await database.acquireCollectionServiceLease(
      serviceName,
      ownerId,
      now.toISOString(),
      new Date(now.getTime() + leaseMs).toISOString(),
    );
    if (!leaseAcquired) throw new Error(`another active derivation service owns ${serviceName}`);
    while (!shutdown.signal.aborted) {
      const cycleStarted = new Date();
      const asOf = cycleStarted.toISOString();
      const paperLabDue =
        lastPaperLabAt === undefined ||
        cycleStarted.getTime() - lastPaperLabAt.getTime() >= paperLabIntervalSeconds * 1000;
      const paperLab = paperLabDue ? await database.runPaperStyleLabCycle(asOf) : undefined;
      if (paperLab !== undefined) lastPaperLabAt = cycleStarted;
      const capitalFlowEpisodes = await database.materializeCapitalFlowEpisodes({
        asOf,
        windowSeconds: 60,
        finalizationGraceSeconds: 120,
        maximumWindows: 100,
      });
      const episodeProtocolContexts = await database.materializeEpisodeProtocolContexts({
        asOf,
        maximumEpisodes: 500,
      });
      const marketReactions = await matureMarketReactions(database, {
        targets: [
          {
            venue: "coinbase-exchange",
            instrumentId: deterministicDomainId("instrument", "coinbase:SOL-USD"),
          },
          {
            venue: "binance-us-spot",
            instrumentId: deterministicDomainId("instrument", "binance-us-spot:SOLUSDT"),
          },
        ],
        windowsSeconds: [60, 300, 900, 3600, 21_600, 86_400],
        asOf,
        maximumEventsPerWindow: 5,
        maximumSnapshotAgeSeconds: 60,
      });
      const marketRegime = await database.computeAndPersistMarketRegime({
        asOf,
        windowSeconds: 3600,
        minimumSamples: 12,
        directionThresholdPct: 0.25,
        volatilityThresholdPct: 0.15,
      });
      const capitalOutcomesLabeled = await database.labelCapitalEventForwardOutcomes(
        asOf,
        30,
        60,
        50,
      );
      const benchmarkOutcomesLabeled = await database.labelCapitalEventBenchmarkOutcomes({
        venue: "coinbase-exchange",
        instrumentId: deterministicDomainId("instrument", "coinbase:BTC-USD"),
        asOf,
        maximumEntryAgeSeconds: 30,
        maximumExitDelaySeconds: 60,
        maximumEvents: 50,
      });
      const protocolFlowWindows = await database.materializePumpSwapFlowWindows(asOf);
      const protocolFlowOutcomesLabeled = await database.labelPumpSwapFlowForwardOutcomes(asOf);
      const protocolFlowBenchmarkOutcomesLabeled =
        await database.labelPumpSwapFlowBenchmarkOutcomes({ asOf });
      const ownerExtraction = await runOwnerExtractionBatch(database, maximumOwnerBlocks, 2);
      const refreshEntityRollup = shouldRefreshEntityRollup({
        completedCycles,
        ownerExtractionRemaining: ownerExtraction.remaining,
        completionRollupPerformed: ownerExtractionCompletionRollupPerformed,
      });
      const entityRollup = refreshEntityRollup
        ? await database.refreshEntityActivityRollup(asOf, 100_000)
        : undefined;
      if (!ownerExtraction.remaining && refreshEntityRollup)
        ownerExtractionCompletionRollupPerformed = true;
      completedCycles += 1;
      const heartbeatAt = new Date();
      const heartbeat = await database.heartbeatCollectionServiceLease(
        serviceName,
        ownerId,
        heartbeatAt.toISOString(),
        new Date(heartbeatAt.getTime() + leaseMs).toISOString(),
      );
      if (!heartbeat) throw new Error("derivation service lease was lost");
      await writeManifest(manifestPath, {
        mode: "READ_ONLY_DERIVATION",
        authority: "NO_WALLET_NO_SIGNING_NO_SUBMISSION_NO_ORDERS",
        serviceName,
        ownerId,
        startedAt: startedAt.toISOString(),
        heartbeatAt: heartbeatAt.toISOString(),
        deadlineAt: deadlineAt.toISOString(),
        completedCycles,
        latestCycle: {
          cycle: completedCycles,
          startedAt: cycleStarted.toISOString(),
          completedAt: heartbeatAt.toISOString(),
          capitalFlowEpisodes,
          episodeProtocolContexts,
          marketReactions,
          marketRegime,
          capitalOutcomesLabeled,
          benchmarkOutcomesLabeled,
          protocolFlowWindows,
          protocolFlowOutcomesLabeled,
          protocolFlowBenchmarkOutcomesLabeled,
          ownerExtraction,
          ...(entityRollup === undefined ? {} : { entityRollup }),
          ...(paperLab === undefined ? {} : { paperLab }),
        },
      });
      await delay(intervalSeconds * 1000, shutdown.signal);
    }
    await database.releaseCollectionServiceLease(
      serviceName,
      ownerId,
      new Date().toISOString(),
      "STOPPED",
    );
  } catch (error: unknown) {
    if (leaseAcquired)
      await database.releaseCollectionServiceLease(
        serviceName,
        ownerId,
        new Date().toISOString(),
        "FAILED",
        error instanceof Error ? error.message : String(error),
      );
    throw error;
  } finally {
    clearTimeout(deadline);
    shutdown.abort();
    await database.close();
  }
}
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
