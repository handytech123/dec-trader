import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CoinbasePublicRestTradeSource,
  CoinbasePublicWebSocketFactory,
} from "@autonomous-trading-lab/coinbase-market-provider";
import {
  BinancePublicRestDepthSource,
  BinancePublicWebSocketFactory,
} from "@autonomous-trading-lab/binance-market-provider";
import {
  HttpJsonRpcTransport,
  SolanaChainProvider,
} from "@autonomous-trading-lab/solana-chain-provider";
import { ResearchDatabase } from "./database.js";
import { databaseLocation } from "./database-location.js";
import { deterministicDomainId } from "./ids.js";
import { matureMarketReactions } from "./market-reaction-worker.js";
import { runOwnerExtractionBatch } from "./owner-extraction-worker.js";
import {
  drainSolanaNormalizationQueue,
  runBoundedBinanceObservation,
  runBoundedCoinbaseObservation,
  runBoundedSolanaCapture,
  runBoundedSolanaNormalizationWorker,
} from "./observation.js";

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

async function writeManifest(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  // Both paths are fixed filenames under the explicitly selected output directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await rename(temporary, path);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay) => {
    if (signal.aborted) {
      resolveDelay();
      return;
    }
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
}

async function runReferencePriceWorker(
  database: ResearchDatabase,
  signal: AbortSignal,
  intervalMs: number,
  coinbaseProduct: string,
  coinbaseBasisProduct: string,
  binanceVenue: string,
  binanceSymbol: string,
): Promise<{ readonly computed: number; readonly published: number; readonly withheld: number }> {
  let computed = 0;
  let published = 0;
  let withheld = 0;
  const aborted = (): boolean => signal.aborted;
  while (!aborted()) {
    await delay(intervalMs, signal);
    if (aborted()) break;
    const estimate = await database.computeAndPersistReferencePrice(
      [
        {
          venue: "coinbase-exchange",
          instrumentId: deterministicDomainId("instrument", `coinbase:${coinbaseProduct}`),
          baseAsset: "SOL",
          quoteAsset: "USD",
        },
        {
          venue: binanceVenue,
          instrumentId: deterministicDomainId("instrument", `${binanceVenue}:${binanceSymbol}`),
          baseAsset: "SOL",
          quoteAsset: "USDT",
        },
      ],
      {
        venue: "coinbase-exchange",
        instrumentId: deterministicDomainId("instrument", `coinbase:${coinbaseBasisProduct}`),
        baseAsset: "USDT",
        quoteAsset: "USD",
      },
      {
        baseAsset: "SOL",
        asOf: new Date().toISOString(),
        minimumVenues: 2,
        maximumAgeMs: 30_000,
        maximumBasisAgeMs: 60_000,
        maximumDeviationBps: 100,
        maximumSpreadBps: 100,
      },
    );
    computed += 1;
    if (estimate.status === "PUBLISHED") published += 1;
    else withheld += 1;
  }
  return { computed, published, withheld };
}

async function runLeaseHeartbeatWorker(
  database: ResearchDatabase,
  signal: AbortSignal,
  serviceName: string,
  ownerId: string,
  leaseSeconds: number,
): Promise<{ readonly heartbeats: number }> {
  let heartbeats = 0;
  const aborted = (): boolean => signal.aborted;
  while (!aborted()) {
    await delay(30_000, signal);
    if (aborted()) break;
    const heartbeatAt = new Date();
    const updated = await database.heartbeatCollectionServiceLease(
      serviceName,
      ownerId,
      heartbeatAt.toISOString(),
      new Date(heartbeatAt.getTime() + leaseSeconds * 1000).toISOString(),
    );
    if (!updated) throw new Error("collection service lease was lost during capture");
    heartbeats += 1;
  }
  return { heartbeats };
}

async function main(): Promise<void> {
  if (!process.argv.includes("--enable-read-only-service"))
    throw new Error("collection service is disabled; pass --enable-read-only-service explicitly");
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
  const solanaRpc = process.env.CFIE_SOLANA_RPC_URL ?? option("--solana-rpc");
  if (!solanaRpc) throw new Error("CFIE_SOLANA_RPC_URL or --solana-rpc is required");
  const coinbaseWebSocket = requiredOption("--coinbase-websocket");
  const coinbaseRest = requiredOption("--coinbase-rest");
  const coinbaseProduct = requiredOption("--coinbase-product");
  const coinbaseBasisProduct = requiredOption("--coinbase-basis-product");
  const coinbaseBenchmarkProduct = option("--coinbase-benchmark-product") ?? "BTC-USD";
  const binanceWebSocket = requiredOption("--binance-websocket");
  const binanceRest = requiredOption("--binance-rest");
  const binanceSymbol = requiredOption("--binance-symbol");
  const binanceVenue = requiredOption("--binance-venue");
  const maximumRuntimeSeconds = integerOption("--max-runtime-seconds", 86_400, 60, 604_800);
  const segmentSeconds = integerOption("--segment-seconds", 3600, 60, 3600);
  const retentionDays = integerOption("--retention-days", 0, 0, 3650);
  const maximumCycleFailures = integerOption("--max-cycle-failures", 10, 0, 1000);
  const failureBackoffSeconds = integerOption("--failure-backoff-seconds", 30, 1, 3600);
  const pollIntervalMs = integerOption("--solana-poll-interval-ms", 10_000, 250, 60_000);
  const rpcMinimumRequestIntervalMs = integerOption(
    "--solana-rpc-min-request-interval-ms",
    0,
    0,
    60_000,
  );
  const referenceIntervalMs = integerOption("--reference-interval-ms", 10_000, 1000, 60_000);
  const maximumReactionEventsPerWindow = integerOption(
    "--max-reaction-events-per-window",
    100,
    1,
    10_000,
  );
  const reactionSnapshotAgeSeconds = integerOption("--reaction-snapshot-age-seconds", 60, 1, 3600);
  const maximumGeneralOutcomeEventsPerCycle = integerOption(
    "--max-general-outcome-events-per-cycle",
    0,
    0,
    100_000,
  );
  const maximumGeneralBenchmarkEventsPerCycle = integerOption(
    "--max-general-benchmark-events-per-cycle",
    0,
    0,
    100_000,
  );
  const maximumBatchSlots = integerOption("--solana-max-batch-slots", 2, 1, 500);
  const maximumParallelBlocks = integerOption("--solana-max-parallel-blocks", 1, 1, 32);
  const normalizationClaimBatchSize = integerOption("--normalization-claim-batch-size", 10, 1, 100);
  const normalizationMaximumParallelJobs = integerOption(
    "--normalization-max-parallel-jobs",
    4,
    1,
    32,
  );
  const maximumLiveTailLagSlots = integerOption(
    "--solana-max-live-tail-lag-slots",
    1000,
    1,
    500_000,
  );
  const serviceName = option("--service-name") ?? "cfie-primary-observer";
  const externalDerivation = process.argv.includes("--external-derivation");
  const ownerId = randomUUID();
  const startedAt = new Date();
  const deadlineAt = new Date(startedAt.getTime() + maximumRuntimeSeconds * 1000);
  const manifestPath = resolve(outputDirectory, "collection-service.json");
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
  let terminalError: string | undefined;
  const cycles: unknown[] = [];
  let completedCycles = 0;
  let failedCycles = 0;
  try {
    await database.migrate(resolve(root, "infra/postgres/migrations"));
    // Heartbeats run at one third of this interval. Keep crash recovery short enough
    // for unattended Windows restarts without sacrificing multiple missed beats.
    const leaseSeconds = 90;
    const leaseNow = new Date();
    leaseAcquired = await database.acquireCollectionServiceLease(
      serviceName,
      ownerId,
      leaseNow.toISOString(),
      new Date(leaseNow.getTime() + leaseSeconds * 1000).toISOString(),
    );
    if (!leaseAcquired) throw new Error(`another active collector owns service ${serviceName}`);
    await writeManifest(manifestPath, {
      mode: "READ_ONLY_CONTINUOUS_OBSERVATION",
      status: "STARTING",
      authority: "NO_WALLET_NO_SIGNING_NO_SUBMISSION_NO_ORDERS",
      serviceName,
      ownerId,
      startedAt: startedAt.toISOString(),
      heartbeatAt: leaseNow.toISOString(),
      deadlineAt: deadlineAt.toISOString(),
      completedCycles,
      failedCycles,
      recentCycles: cycles,
    });
    const solana = new SolanaChainProvider(
      new HttpJsonRpcTransport(solanaRpc, 20_000, rpcMinimumRequestIntervalMs),
    );
    const initialSlot = (await solana.latestFinalizedSlot()) + 1;
    const checkpointStorage = database.chainCollectionStorage();
    const checkpoint = await checkpointStorage.load(solana.providerId(), "solana");
    if (
      checkpoint !== undefined &&
      initialSlot - 1 - checkpoint.lastFinalizedSlot > maximumLiveTailLagSlots
    ) {
      const detectedAt = new Date().toISOString();
      await checkpointStorage.recordGap({
        providerId: solana.providerId(),
        chain: "solana",
        startSlot: checkpoint.lastFinalizedSlot + 1,
        endSlot: initialSlot - 1,
        detectedAt,
        reason: "LIVE_TAIL_FAST_FORWARD",
      });
      await checkpointStorage.save({
        providerId: solana.providerId(),
        chain: "solana",
        lastFinalizedSlot: initialSlot - 1,
        updatedAt: detectedAt,
      });
    }
    const coinbaseFactory = new CoinbasePublicWebSocketFactory({
      endpoint: coinbaseWebSocket,
      productIds: [coinbaseProduct],
      connectionTimeoutMs: 10_000,
    });
    const coinbaseBackfill = new CoinbasePublicRestTradeSource({
      endpoint: coinbaseRest,
      timeoutMs: 10_000,
    });
    const coinbaseBasisFactory = new CoinbasePublicWebSocketFactory({
      endpoint: coinbaseWebSocket,
      productIds: [coinbaseBasisProduct],
      connectionTimeoutMs: 10_000,
    });
    const coinbaseBenchmarkFactory = new CoinbasePublicWebSocketFactory({
      endpoint: coinbaseWebSocket,
      productIds: [coinbaseBenchmarkProduct],
      connectionTimeoutMs: 10_000,
    });
    const binanceFactory = new BinancePublicWebSocketFactory({
      endpoint: binanceWebSocket,
      symbol: binanceSymbol,
      connectionTimeoutMs: 10_000,
    });
    const binanceMarket = new BinancePublicRestDepthSource({
      endpoint: binanceRest,
      timeoutMs: 10_000,
    });
    while (!shutdown.signal.aborted) {
      const cycleStarted = new Date();
      const remainingMs = deadlineAt.getTime() - cycleStarted.getTime();
      if (remainingMs <= 0) break;
      const cycleDurationSeconds = Math.max(
        1,
        Math.min(segmentSeconds, Math.ceil(remainingMs / 1000)),
      );
      const cycleAbort = new AbortController();
      const forwardAbort = (): void => {
        cycleAbort.abort();
      };
      shutdown.signal.addEventListener("abort", forwardAbort, { once: true });
      const cycleDeadline = setTimeout(() => {
        cycleAbort.abort();
      }, cycleDurationSeconds * 1000);
      try {
        const tasks = [
          runBoundedSolanaCapture(
            solana,
            database,
            {
              initialSlot,
              maximumBatchSlots,
              maximumPolls: Math.ceil((cycleDurationSeconds * 1000) / pollIntervalMs) + 1,
              pollIntervalMs,
              maximumConsecutiveFailures: 5,
              failureBackoffMs: 5000,
              maximumParallelBlocks,
              maximumPendingNormalizationJobs: 10_000,
              maximumLiveTailLagSlots,
            },
            cycleAbort.signal,
          ),
          runBoundedCoinbaseObservation(
            coinbaseFactory,
            database,
            {
              maximumMessages: 1_000_000,
              maximumDurationMs: cycleDurationSeconds * 1000,
              reconnect: { maximumAttempts: 20, baseDelayMs: 1000, maximumDelayMs: 30_000 },
              maximumBackfillTrades: 1000,
              bookSnapshotIntervalMs: 1000,
            },
            cycleAbort.signal,
            undefined,
            coinbaseBackfill,
            coinbaseProduct,
          ),
          runBoundedBinanceObservation(
            binanceFactory,
            binanceMarket,
            database,
            binanceSymbol,
            binanceVenue,
            {
              maximumMessages: 1_000_000,
              maximumDurationMs: cycleDurationSeconds * 1000,
              reconnect: { maximumAttempts: 20, baseDelayMs: 1000, maximumDelayMs: 30_000 },
              maximumBackfillTrades: 1000,
              bookSnapshotIntervalMs: 1000,
            },
            cycleAbort.signal,
          ),
          runBoundedCoinbaseObservation(
            coinbaseBasisFactory,
            database,
            {
              maximumMessages: 1_000_000,
              maximumDurationMs: cycleDurationSeconds * 1000,
              reconnect: { maximumAttempts: 20, baseDelayMs: 1000, maximumDelayMs: 30_000 },
              maximumBackfillTrades: 1000,
              bookSnapshotIntervalMs: 1000,
            },
            cycleAbort.signal,
            undefined,
            coinbaseBackfill,
            coinbaseBasisProduct,
          ),
          runBoundedCoinbaseObservation(
            coinbaseBenchmarkFactory,
            database,
            {
              maximumMessages: 1_000_000,
              maximumDurationMs: cycleDurationSeconds * 1000,
              reconnect: { maximumAttempts: 20, baseDelayMs: 1000, maximumDelayMs: 30_000 },
              maximumBackfillTrades: 1000,
              bookSnapshotIntervalMs: 1000,
            },
            cycleAbort.signal,
            undefined,
            coinbaseBackfill,
            coinbaseBenchmarkProduct,
          ),
          runBoundedSolanaNormalizationWorker(
            database,
            {
              maximumJobs: 1000,
              claimBatchSize: normalizationClaimBatchSize,
              leaseMs: 300_000,
              maximumAttempts: 5,
              retryBackoffMs: 5000,
              maximumParallelJobs: normalizationMaximumParallelJobs,
            },
            Math.ceil((cycleDurationSeconds * 1000) / 1000) + 1,
            1000,
            cycleAbort.signal,
          ),
          runReferencePriceWorker(
            database,
            cycleAbort.signal,
            referenceIntervalMs,
            coinbaseProduct,
            coinbaseBasisProduct,
            binanceVenue,
            binanceSymbol,
          ),
          runLeaseHeartbeatWorker(database, cycleAbort.signal, serviceName, ownerId, leaseSeconds),
        ] as const;
        const [
          solanaResult,
          coinbaseResult,
          binanceResult,
          coinbaseBasisResult,
          coinbaseBenchmarkResult,
          normalizationResult,
          referencePriceResult,
          leaseHeartbeatResult,
        ] = await Promise.all(tasks);
        const capitalFlowEpisodes = externalDerivation
          ? { delegated: true }
          : await database.materializeCapitalFlowEpisodes({
              asOf: new Date().toISOString(),
              windowSeconds: 60,
              finalizationGraceSeconds: 120,
              maximumWindows: 20,
            });
        const episodeProtocolContexts = externalDerivation
          ? { delegated: true }
          : await database.materializeEpisodeProtocolContexts({
              asOf: new Date().toISOString(),
              maximumEpisodes: 100,
            });
        const capitalOutcomesLabeled =
          maximumGeneralOutcomeEventsPerCycle === 0
            ? 0
            : await database.labelCapitalEventForwardOutcomes(
                new Date().toISOString(),
                30,
                60,
                maximumGeneralOutcomeEventsPerCycle,
              );
        const benchmarkOutcomesLabeled =
          maximumGeneralBenchmarkEventsPerCycle === 0
            ? 0
            : await database.labelCapitalEventBenchmarkOutcomes({
                venue: "coinbase-exchange",
                instrumentId: deterministicDomainId(
                  "instrument",
                  `coinbase:${coinbaseBenchmarkProduct}`,
                ),
                asOf: new Date().toISOString(),
                maximumEntryAgeSeconds: 30,
                maximumExitDelaySeconds: 60,
                maximumEvents: maximumGeneralBenchmarkEventsPerCycle,
              });
        const marketReactions = externalDerivation
          ? { delegated: true }
          : await matureMarketReactions(database, {
              targets: [
                {
                  venue: "coinbase-exchange",
                  instrumentId: deterministicDomainId("instrument", `coinbase:${coinbaseProduct}`),
                },
                {
                  venue: binanceVenue,
                  instrumentId: deterministicDomainId(
                    "instrument",
                    `${binanceVenue}:${binanceSymbol}`,
                  ),
                },
              ],
              windowsSeconds: [60, 300, 900, 3600, 21_600, 86_400],
              asOf: new Date().toISOString(),
              maximumEventsPerWindow: maximumReactionEventsPerWindow,
              maximumSnapshotAgeSeconds: reactionSnapshotAgeSeconds,
            });
        const marketRegime = externalDerivation
          ? { delegated: true }
          : await database.computeAndPersistMarketRegime({
              asOf: new Date().toISOString(),
              windowSeconds: 3600,
              minimumSamples: 12,
              directionThresholdPct: 0.25,
              volatilityThresholdPct: 0.15,
            });
        const protocolFlowWindows = externalDerivation
          ? { delegated: true }
          : await database.materializePumpSwapFlowWindows(new Date().toISOString());
        const protocolFlowOutcomesLabeled = externalDerivation
          ? 0
          : await database.labelPumpSwapFlowForwardOutcomes(new Date().toISOString());
        const protocolFlowBenchmarkOutcomesLabeled = externalDerivation
          ? 0
          : await database.labelPumpSwapFlowBenchmarkOutcomes({
              asOf: new Date().toISOString(),
            });
        const ownerExtraction = externalDerivation
          ? { delegated: true }
          : await runOwnerExtractionBatch(database, 25, 2);
        const entityRollup =
          !externalDerivation && completedCycles > 0 && completedCycles % 60 === 0
            ? await database.refreshEntityActivityRollup(new Date().toISOString(), 100_000)
            : undefined;
        completedCycles += 1;
        failedCycles = 0;
        cycles.push({
          cycle: completedCycles,
          startedAt: cycleStarted.toISOString(),
          completedAt: new Date().toISOString(),
          solana: solanaResult,
          coinbase: coinbaseResult,
          binance: binanceResult,
          coinbaseBasis: coinbaseBasisResult,
          coinbaseBenchmark: coinbaseBenchmarkResult,
          normalization: normalizationResult,
          referencePrices: referencePriceResult,
          leaseHeartbeats: leaseHeartbeatResult,
          capitalFlowEpisodes,
          episodeProtocolContexts,
          capitalOutcomesLabeled,
          benchmarkOutcomesLabeled,
          marketReactions,
          marketRegime,
          protocolFlowWindows,
          protocolFlowOutcomesLabeled,
          protocolFlowBenchmarkOutcomesLabeled,
          ownerExtraction,
          ...(entityRollup === undefined ? {} : { entityRollup }),
        });
      } catch (error: unknown) {
        cycleAbort.abort();
        failedCycles += 1;
        terminalError = error instanceof Error ? error.message : String(error);
        cycles.push({
          cycle: completedCycles + failedCycles,
          startedAt: cycleStarted.toISOString(),
          failedAt: new Date().toISOString(),
          error: terminalError,
        });
        if (failedCycles > maximumCycleFailures) throw error;
        await delay(failureBackoffSeconds * 1000, shutdown.signal);
      } finally {
        clearTimeout(cycleDeadline);
        shutdown.signal.removeEventListener("abort", forwardAbort);
      }
      if (cycles.length > 100) cycles.shift();
      const heartbeatAt = new Date();
      const heartbeat = await database.heartbeatCollectionServiceLease(
        serviceName,
        ownerId,
        heartbeatAt.toISOString(),
        new Date(heartbeatAt.getTime() + leaseSeconds * 1000).toISOString(),
        terminalError,
      );
      if (!heartbeat) throw new Error("collection service lease was lost");
      const health = await database.operationalHealth(heartbeatAt.toISOString(), 300, 1000);
      await writeManifest(manifestPath, {
        mode: "READ_ONLY_CONTINUOUS_OBSERVATION",
        authority: "NO_WALLET_NO_SIGNING_NO_SUBMISSION_NO_ORDERS",
        serviceName,
        ownerId,
        startedAt: startedAt.toISOString(),
        heartbeatAt: heartbeatAt.toISOString(),
        deadlineAt: deadlineAt.toISOString(),
        completedCycles,
        failedCycles,
        generalOutcomeBackfill: {
          maximumEventsPerCycle: maximumGeneralOutcomeEventsPerCycle,
          maximumBenchmarkEventsPerCycle: maximumGeneralBenchmarkEventsPerCycle,
          protocolFlowOutcomesRemainEnabled: true,
        },
        derivationMode: externalDerivation ? "EXTERNAL_SERVICE" : "INLINE",
        health,
        recentCycles: cycles,
      });
    }
    const drain = await drainSolanaNormalizationQueue(
      database,
      {
        maximumJobs: 100_000,
        claimBatchSize: 50,
        leaseMs: 300_000,
        maximumAttempts: 5,
        retryBackoffMs: 5000,
        maximumParallelJobs: 4,
      },
      new AbortController().signal,
    );
    const completedAt = new Date();
    const retention =
      retentionDays === 0
        ? { policy: "PRESERVE_ALL_RAW_DATA" as const, objectsDeleted: 0 }
        : await database.enforceRawRetention(
            new Date(completedAt.getTime() - retentionDays * 86_400_000).toISOString(),
            10_000,
            completedAt.toISOString(),
          );
    await database.releaseCollectionServiceLease(
      serviceName,
      ownerId,
      completedAt.toISOString(),
      "STOPPED",
    );
    await writeManifest(manifestPath, {
      mode: "READ_ONLY_CONTINUOUS_OBSERVATION",
      status: "STOPPED",
      authority: "NO_WALLET_NO_SIGNING_NO_SUBMISSION_NO_ORDERS",
      serviceName,
      ownerId,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      completedCycles,
      failedCycles,
      generalOutcomeBackfill: {
        maximumEventsPerCycle: maximumGeneralOutcomeEventsPerCycle,
        maximumBenchmarkEventsPerCycle: maximumGeneralBenchmarkEventsPerCycle,
        protocolFlowOutcomesRemainEnabled: true,
      },
      drain,
      retention,
      recentCycles: cycles,
    });
    process.stdout.write(
      `${JSON.stringify({ status: "STOPPED", serviceName, completedCycles, failedCycles, manifestPath })}\n`,
    );
  } catch (error: unknown) {
    terminalError = error instanceof Error ? error.message : String(error);
    if (leaseAcquired)
      await database.releaseCollectionServiceLease(
        serviceName,
        ownerId,
        new Date().toISOString(),
        "FAILED",
        terminalError,
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
