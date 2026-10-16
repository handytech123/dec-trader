import { resolve } from "node:path";
import { ResearchDatabase } from "./database.js";
import { databaseLocation } from "./database-location.js";
import { deterministicDomainId } from "./ids.js";

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

async function main(): Promise<void> {
  const root = process.env.INIT_CWD ?? process.cwd();
  const databasePath = databaseLocation(
    root,
    process.env.CFIE_DATABASE_URL ?? requiredOption("--database"),
  );
  const asOf = option("--as-of") ?? new Date().toISOString();
  const database = new ResearchDatabase(databasePath);
  try {
    await database.migrate(resolve(root, "infra/postgres/migrations"));
    const estimate = await database.computeAndPersistReferencePrice(
      [
        {
          venue: "coinbase-exchange",
          instrumentId: deterministicDomainId("instrument", "coinbase:SOL-USD"),
          baseAsset: "SOL",
          quoteAsset: "USD",
        },
        {
          venue: requiredOption("--binance-venue"),
          instrumentId: deterministicDomainId(
            "instrument",
            `${requiredOption("--binance-venue")}:${requiredOption("--binance-symbol")}`,
          ),
          baseAsset: "SOL",
          quoteAsset: "USDT",
        },
      ],
      {
        venue: "coinbase-exchange",
        instrumentId: deterministicDomainId("instrument", "coinbase:USDT-USD"),
        baseAsset: "USDT",
        quoteAsset: "USD",
      },
      {
        baseAsset: "SOL",
        asOf,
        minimumVenues: 2,
        maximumAgeMs: integerOption("--maximum-age-ms", 30_000, 100, 300_000),
        maximumBasisAgeMs: integerOption("--maximum-basis-age-ms", 60_000, 100, 300_000),
        maximumDeviationBps: integerOption("--maximum-deviation-bps", 100, 1, 10_000),
        maximumSpreadBps: integerOption("--maximum-spread-bps", 100, 1, 10_000),
      },
    );
    process.stdout.write(`${JSON.stringify({ databasePath, estimate })}\n`);
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
