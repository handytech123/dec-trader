import { resolve } from "node:path";
import { ResearchDatabase } from "./database.js";
import { databaseLocation } from "./database-location.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
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
    const feature = await database.walletBehaviorFeature(
      requiredOption("--event-id"),
      requiredOption("--entity-id"),
    );
    process.stdout.write(
      `${JSON.stringify({ authority: "READ_ONLY_ENTITY_INTELLIGENCE", feature }, null, 2)}\n`,
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
