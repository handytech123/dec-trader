import { fileURLToPath } from "node:url";
import { ResearchDatabase } from "./database.js";
import { databaseDisplayLocation, databaseLocation } from "./database-location.js";
import { runOwnerExtractionBatch } from "./owner-extraction-worker.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function integerOption(name: string, fallback: number, maximum: number): number {
  const value = Number(option(name) ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > maximum)
    throw new Error(`${name} must be between 1 and ${String(maximum)}`);
  return value;
}

async function main(): Promise<void> {
  if (!process.argv.includes("--backfill-solana-owners"))
    throw new Error("--backfill-solana-owners is required");
  const root = process.env.INIT_CWD ?? process.cwd();
  const candidate = process.env.CFIE_DATABASE_URL ?? option("--database");
  if (!candidate) throw new Error("--database or CFIE_DATABASE_URL is required");
  const maximumBlocks = integerOption("--maximum-blocks", 10_000, 1_000_000);
  const batchSize = integerOption("--batch-size", 100, 1_000);
  const parallelism = integerOption("--parallelism", 4, 16);
  const location = databaseLocation(root, candidate);
  const database = new ResearchDatabase(location);
  let blocksProcessed = 0;
  let observationsFound = 0;
  let observationsInserted = 0;
  const startedAt = Date.now();
  try {
    await database.migrate(
      fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
    );
    while (blocksProcessed < maximumBlocks) {
      const batch = await runOwnerExtractionBatch(
        database,
        Math.min(batchSize, maximumBlocks - blocksProcessed),
        parallelism,
      );
      blocksProcessed += batch.blocksProcessed;
      observationsFound += batch.observationsFound;
      observationsInserted += batch.observationsInserted;
      if (batch.blocksProcessed === 0 || !batch.remaining) break;
    }
    const remaining = (await database.pendingSolanaOwnerExtractionHashes(1)).length;
    const rollup =
      remaining === 0 && process.argv.includes("--refresh-rollup-after")
        ? await database.refreshEntityActivityRollup(new Date().toISOString(), 100_000)
        : undefined;
    process.stdout.write(
      `${JSON.stringify(
        {
          authority: "READ_ONLY_EVIDENCE_DERIVATION",
          database: databaseDisplayLocation(location),
          blocksProcessed,
          parallelism,
          observationsFound,
          observationsInserted,
          remaining,
          ...(rollup === undefined ? {} : { rollup }),
          elapsedMilliseconds: Date.now() - startedAt,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
