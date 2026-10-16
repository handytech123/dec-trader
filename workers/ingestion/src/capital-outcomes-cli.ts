import { resolve } from "node:path";
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
  const database = new ResearchDatabase(databasePath);
  try {
    await database.migrate(resolve(root, "infra/postgres/migrations"));
    const asOf = option("--as-of") ?? new Date().toISOString();
    const labeled = await database.labelCapitalEventForwardOutcomes(
      asOf,
      integerOption("--maximum-entry-age-seconds", 30, 1, 3600),
      integerOption("--maximum-exit-delay-seconds", 60, 1, 3600),
    );
    process.stdout.write(
      `${JSON.stringify({ databasePath: databaseDisplayLocation(databasePath), asOf, labeled })}\n`,
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
