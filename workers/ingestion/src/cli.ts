import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { appendCaptureSpool, captureWatchlistDetailed } from "./capture.js";
import { ResearchDatabase } from "./database.js";
import { DexScreenerProvider } from "./dexscreener.js";
import { deterministicDomainId } from "./ids.js";
import { WatchlistSchema } from "./schemas.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function integerOption(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${String(minimum)} and ${String(maximum)}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const watchlistArgument = option("--watchlist");
  if (!watchlistArgument) throw new Error("--watchlist is required");
  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  const watchlistPath = resolve(invocationDirectory, watchlistArgument);
  const outputPath = resolve(
    invocationDirectory,
    option("--output") ?? ".atl-data/dex-observations.jsonl",
  );
  const databasePath = resolve(
    invocationDirectory,
    option("--database") ?? ".atl-data/research-db",
  );
  const migrationsPath = resolve(invocationDirectory, "infra/postgres/migrations");
  // User-selected local configuration is parsed strictly before use.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const watchlist = WatchlistSchema.parse(JSON.parse(await readFile(watchlistPath, "utf8")));
  const database = new ResearchDatabase(databasePath);
  try {
    await database.migrate(migrationsPath);
    const startedAt = new Date().toISOString();
    const result = await captureWatchlistDetailed(watchlist, new DexScreenerProvider(), {
      topPools: integerOption("--top-pools", 3, 1, 20),
      timeoutMs: integerOption("--timeout-ms", 10_000, 1_000, 30_000),
      capturedAt: startedAt,
    });
    const completedAt = new Date().toISOString();
    await appendCaptureSpool(outputPath, result.records);
    const status =
      result.failures.length === 0
        ? "COMPLETED"
        : result.records.length === 0
          ? "FAILED"
          : "PARTIAL";
    await database.persistCapture(
      {
        collectionRunId: deterministicDomainId("collection", startedAt),
        source: "dexscreener-token-pairs-v1",
        startedAt,
        completedAt,
        requestedAssets: watchlist.assets.length,
        capturedObservations: result.records.length,
        errorCount: result.failures.length,
        status,
        details: { topPools: integerOption("--top-pools", 3, 1, 20) },
      },
      result.records,
      result.failures,
    );
    const featuresComputed = await database.computeAndPersistFeatures();
    const outcomesLabeled = await database.labelMaturedOutcomes(completedAt);
    const health = await database.health();
    process.stdout.write(
      `${JSON.stringify({
        assetsRequested: watchlist.assets.length,
        observationsCaptured: result.records.length,
        errors: result.failures.length,
        featuresComputed,
        outcomesLabeled,
        outputPath,
        databasePath,
        health,
      })}\n`,
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
