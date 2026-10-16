import { resolve } from "node:path";
import {
  downloadBinanceArchive,
  parseBinanceTradeCsv,
  type BinanceArchiveInterval,
  type BinanceArchiveKind,
} from "@autonomous-trading-lab/binance-market-provider";
import { ResearchDatabase } from "./database.js";
import { databaseDisplayLocation, databaseLocation } from "./database-location.js";

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
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`${name} must be between ${String(minimum)} and ${String(maximum)}`);
  return parsed;
}

async function main(): Promise<void> {
  if (!process.argv.includes("--enable-read-only-backfill"))
    throw new Error("backfill is disabled; pass --enable-read-only-backfill explicitly");
  const kind = requiredOption("--kind") as BinanceArchiveKind;
  const interval = requiredOption("--interval") as BinanceArchiveInterval;
  const request = {
    symbol: requiredOption("--symbol"),
    kind,
    interval,
    period: requiredOption("--period"),
  };
  const root = process.env.INIT_CWD ?? process.cwd();
  const databasePath = databaseLocation(
    root,
    process.env.CFIE_DATABASE_URL ?? option("--database") ?? ".atl-data/research-db",
  );
  const maximumRecords = integerOption("--max-records", 1_000_000, 1, 10_000_000);
  const ingestedAt = new Date().toISOString();
  const endpoint = option("--endpoint");
  const artifact = await downloadBinanceArchive(request, {
    ...(endpoint === undefined ? {} : { endpoint }),
    maximumArchiveBytes: integerOption("--max-archive-bytes", 250_000_000, 1024, 1_000_000_000),
    timeoutMs: integerOption("--timeout-ms", 120_000, 1000, 120_000),
  });
  const records = parseBinanceTradeCsv(artifact.csv, request, ingestedAt, maximumRecords);
  const database = new ResearchDatabase(databasePath);
  let inserted = 0;
  try {
    await database.migrate(resolve(root, "infra/postgres/migrations"));
    const batchSize = integerOption("--batch-size", 1000, 1, 5000);
    for (let index = 0; index < records.length; index += batchSize) {
      inserted += await database.persistHistoricalMarketBatch(
        records.slice(index, index + batchSize).map((record) => ({
          ...record,
          productId: request.symbol,
          messageType: `HISTORICAL_${kind.toUpperCase()}`,
        })),
      );
    }
  } finally {
    await database.close();
  }
  process.stdout.write(
    `${JSON.stringify({
      mode: "READ_ONLY_HISTORICAL_BACKFILL",
      provider: "binance-vision",
      venue: "binance-spot",
      request,
      archiveUrl: artifact.archiveUrl,
      archiveSha256: artifact.archiveSha256,
      recordsRead: records.length,
      recordsInserted: inserted,
      duplicateRecords: records.length - inserted,
      databasePath: databaseDisplayLocation(databasePath),
    })}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
