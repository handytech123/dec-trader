import { resolve } from "node:path";
import { ResearchDatabase } from "./database.js";
import { databaseLocation } from "./database-location.js";

function requiredOption(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalInteger(name: string, fallback: number, minimum: number): number {
  const index = process.argv.indexOf(name);
  const candidate = index < 0 ? undefined : process.argv[index + 1];
  if (candidate === undefined) return fallback;
  const value = Number(candidate);
  if (!Number.isInteger(value) || value < minimum)
    throw new Error(`${name} must be an integer of at least ${String(minimum)}`);
  return value;
}

async function main(): Promise<void> {
  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  const database = new ResearchDatabase(
    databaseLocation(
      invocationDirectory,
      process.env.CFIE_DATABASE_URL ?? requiredOption("--database-path"),
    ),
  );
  try {
    await database.migrate(resolve(invocationDirectory, "infra/postgres/migrations"));
    const [operationalHealth, recentRetentionRuns] = await Promise.all([
      database.operationalHealth(
        new Date().toISOString(),
        optionalInteger("--freshness-seconds", 300, 1),
        optionalInteger("--max-pending-jobs", 1000, 1),
      ),
      database.recentRawRetentionRuns(10),
    ]);
    process.stdout.write(`${JSON.stringify({ operationalHealth, recentRetentionRuns })}\n`);
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
