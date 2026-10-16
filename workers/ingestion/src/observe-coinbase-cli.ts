import { resolve } from "node:path";
import {
  CoinbasePublicRestTradeSource,
  CoinbasePublicWebSocketFactory,
} from "@autonomous-trading-lab/coinbase-market-provider";
import { ResearchDatabase } from "./database.js";
import { databaseDisplayLocation, databaseLocation } from "./database-location.js";
import { runBoundedCoinbaseObservation } from "./observation.js";

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

async function main(): Promise<void> {
  if (!process.argv.includes("--enable-read-only-observation"))
    throw new Error("observation is disabled; pass --enable-read-only-observation explicitly");
  const endpoint = requiredOption("--websocket-endpoint");
  const productIds = requiredOption("--products")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const maximumMessages = requiredInteger("--max-messages", 1, 1_000_000);
  const maximumDurationSeconds = requiredInteger("--max-duration-seconds", 1, 3600);
  const maximumAttempts = requiredInteger("--max-reconnects", 0, 20);
  const baseDelayMs = requiredInteger("--base-reconnect-ms", 100, 30_000);
  const maximumDelayMs = requiredInteger("--max-reconnect-ms", 100, 60_000);
  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  const databasePath = databaseLocation(
    invocationDirectory,
    process.env.CFIE_DATABASE_URL ?? requiredOption("--database"),
  );
  const migrationsPath = resolve(invocationDirectory, "infra/postgres/migrations");
  const database = new ResearchDatabase(databasePath);
  try {
    await database.migrate(migrationsPath);
    const factory = new CoinbasePublicWebSocketFactory({
      endpoint,
      productIds,
      connectionTimeoutMs: requiredInteger("--connection-timeout-ms", 1000, 30_000),
    });
    const restEndpoint = option("--rest-endpoint");
    const maximumBackfillTrades = restEndpoint
      ? requiredInteger("--max-backfill-trades", 1, 1000)
      : 100;
    const backfillSource = restEndpoint
      ? new CoinbasePublicRestTradeSource({
          endpoint: restEndpoint,
          timeoutMs: requiredInteger("--rest-timeout-ms", 1000, 30_000),
        })
      : undefined;
    const result = await runBoundedCoinbaseObservation(
      factory,
      database,
      {
        maximumMessages,
        maximumDurationMs: maximumDurationSeconds * 1000,
        reconnect: { maximumAttempts, baseDelayMs, maximumDelayMs },
        maximumBackfillTrades,
      },
      new AbortController().signal,
      undefined,
      backfillSource,
      productIds.length === 1 ? productIds[0] : undefined,
    );
    process.stdout.write(
      `${JSON.stringify({
        mode: "READ_ONLY_OBSERVATION",
        venue: "coinbase-exchange",
        productIds,
        limits: {
          maximumMessages,
          maximumDurationSeconds,
          maximumAttempts,
          baseDelayMs,
          maximumDelayMs,
          maximumBackfillTrades,
          restBackfillEnabled: backfillSource !== undefined,
        },
        databasePath: databaseDisplayLocation(databasePath),
        result,
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
