import { resolve } from "node:path";
import { ResearchDatabase } from "./database.js";
import { databaseLocation } from "./database-location.js";

function requiredOption(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
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
  if (!process.argv.includes("--enable-retention-prune"))
    throw new Error("retention pruning is disabled; pass --enable-retention-prune explicitly");
  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  const databasePath = databaseLocation(
    invocationDirectory,
    process.env.CFIE_DATABASE_URL ?? requiredOption("--database-path"),
  );
  const retentionDays = requiredInteger("--retention-days", 1, 3650);
  const maximumObjects = requiredInteger("--maximum-objects", 1, 10_000);
  const executedAt = new Date();
  const cutoffAt = new Date(executedAt.getTime() - retentionDays * 24 * 60 * 60_000).toISOString();
  const database = new ResearchDatabase(databasePath);
  try {
    await database.migrate(resolve(invocationDirectory, "infra/postgres/migrations"));
    const result = await database.enforceRawRetention(
      cutoffAt,
      maximumObjects,
      executedAt.toISOString(),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
