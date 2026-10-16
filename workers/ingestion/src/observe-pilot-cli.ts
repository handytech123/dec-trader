import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CoinbasePublicRestTradeSource,
  CoinbasePublicWebSocketFactory,
} from "@autonomous-trading-lab/coinbase-market-provider";
import {
  HttpJsonRpcTransport,
  SolanaChainProvider,
} from "@autonomous-trading-lab/solana-chain-provider";
import { ResearchDatabase } from "./database.js";
import {
  drainSolanaNormalizationQueue,
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

function requiredInteger(name: string, minimum: number, maximum: number): number {
  const value = Number(requiredOption(name));
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer between ${String(minimum)} and ${String(maximum)}`);
  return value;
}

function optionalInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const candidate = option(name);
  if (candidate === undefined) return fallback;
  const value = Number(candidate);
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer between ${String(minimum)} and ${String(maximum)}`);
  return value;
}

async function main(): Promise<void> {
  if (!process.argv.includes("--enable-read-only-observation"))
    throw new Error("observation is disabled; pass --enable-read-only-observation explicitly");
  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  const outputDirectory = resolve(invocationDirectory, requiredOption("--output-directory"));
  const databasePath = resolve(outputDirectory, "research-db");
  const migrationsPath = resolve(invocationDirectory, "infra/postgres/migrations");
  const durationSeconds = requiredInteger("--duration-seconds", 1, 86_400);
  const retentionDays = requiredInteger("--retention-days", 1, 365);
  const pollIntervalMs = requiredInteger("--solana-poll-interval-ms", 250, 60_000);
  const maximumBatchSlots = optionalInteger("--solana-max-batch-slots", 2, 1, 500);
  const maximumParallelBlocks = optionalInteger("--solana-max-parallel-blocks", 1, 1, 32);
  const maximumPolls = Math.ceil((durationSeconds * 1000) / pollIntervalMs);
  const startedAt = new Date().toISOString();
  // Explicit CLI output directory is resolved to an absolute local path before use.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(outputDirectory, { recursive: true });
  const database = new ResearchDatabase(databasePath);
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort();
  }, durationSeconds * 1000);
  try {
    await database.migrate(migrationsPath);
    const solanaRpc = option("--solana-rpc") ?? process.env.CFIE_SOLANA_RPC_URL;
    if (!solanaRpc)
      throw new Error("--solana-rpc or the CFIE_SOLANA_RPC_URL environment variable is required");
    const solana = new SolanaChainProvider(new HttpJsonRpcTransport(solanaRpc, 20_000));
    const initialSlot = (await solana.latestFinalizedSlot()) + 1;
    const coinbase = new CoinbasePublicWebSocketFactory({
      endpoint: requiredOption("--coinbase-websocket"),
      productIds: [requiredOption("--coinbase-product")],
      connectionTimeoutMs: 10_000,
    });
    const coinbaseRestEndpoint = option("--coinbase-rest");
    const coinbaseBackfill = coinbaseRestEndpoint
      ? new CoinbasePublicRestTradeSource({ endpoint: coinbaseRestEndpoint, timeoutMs: 10_000 })
      : undefined;
    const normalizationLimits = {
      maximumJobs: 100,
      claimBatchSize: 10,
      leaseMs: 5 * 60_000,
      maximumAttempts: 3,
      retryBackoffMs: 5000,
      maximumParallelJobs: 4,
    } as const;
    const runSolana = runBoundedSolanaCapture(
      solana,
      database,
      {
        initialSlot,
        maximumBatchSlots,
        maximumPolls,
        pollIntervalMs,
        maximumConsecutiveFailures: 5,
        failureBackoffMs: 5000,
        maximumParallelBlocks,
        maximumPendingNormalizationJobs: 10_000,
      },
      controller.signal,
    ).catch((error: unknown) => {
      controller.abort();
      throw error;
    });
    const runCoinbase = runBoundedCoinbaseObservation(
      coinbase,
      database,
      {
        maximumMessages: 250_000,
        maximumDurationMs: durationSeconds * 1000,
        reconnect: { maximumAttempts: 5, baseDelayMs: 1000, maximumDelayMs: 30_000 },
        maximumBackfillTrades: 100,
      },
      controller.signal,
      undefined,
      coinbaseBackfill,
      requiredOption("--coinbase-product"),
    ).catch((error: unknown) => {
      controller.abort();
      throw error;
    });
    const runNormalization = runBoundedSolanaNormalizationWorker(
      database,
      normalizationLimits,
      Math.ceil((durationSeconds * 1000) / 1000) + 1,
      1000,
      controller.signal,
    ).catch((error: unknown) => {
      controller.abort();
      throw error;
    });
    const [solanaResult, coinbaseResult, liveNormalizationResult] = await Promise.all([
      runSolana,
      runCoinbase,
      runNormalization,
    ]);
    const queueBeforeNormalization = await database.chainNormalizationQueueStatus();
    const finalNormalizationResult = await drainSolanaNormalizationQueue(
      database,
      {
        ...normalizationLimits,
        maximumJobs: 100_000,
      },
      new AbortController().signal,
    );
    const queueAfterNormalization = await database.chainNormalizationQueueStatus();
    const completedAt = new Date().toISOString();
    const retention = await database.enforceRawRetention(
      new Date(new Date(completedAt).getTime() - retentionDays * 24 * 60 * 60_000).toISOString(),
      10_000,
      completedAt,
    );
    const report = {
      mode: "READ_ONLY_OBSERVATION",
      startedAt,
      completedAt,
      durationSeconds,
      retentionDays,
      retention,
      authority: "NO_WALLET_NO_SIGNING_NO_SUBMISSION_NO_ORDERS",
      databasePath,
      solana: {
        initialSlot,
        limits: { maximumBatchSlots, maximumParallelBlocks, pollIntervalMs },
        capture: solanaResult,
        queueBeforeNormalization,
        liveNormalization: liveNormalizationResult,
        finalNormalization: finalNormalizationResult,
        queueAfterNormalization,
      },
      coinbase: {
        productId: requiredOption("--coinbase-product"),
        restBackfillEnabled: coinbaseBackfill !== undefined,
        result: coinbaseResult,
      },
    };
    const reportPath = resolve(outputDirectory, "pilot-result.json");
    // The result path is a fixed filename under the explicit CLI output directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ...report, reportPath })}\n`);
  } finally {
    clearTimeout(deadline);
    controller.abort();
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
