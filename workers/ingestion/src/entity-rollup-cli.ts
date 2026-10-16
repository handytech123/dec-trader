import { fileURLToPath } from "node:url";
import { ResearchDatabase } from "./database.js";
import { databaseDisplayLocation, databaseLocation } from "./database-location.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  if (!process.argv.includes("--refresh-entity-activity-rollup"))
    throw new Error("--refresh-entity-activity-rollup is required");
  const root = process.env.INIT_CWD ?? process.cwd();
  const candidate = process.env.CFIE_DATABASE_URL ?? option("--database");
  if (!candidate) throw new Error("--database or CFIE_DATABASE_URL is required");
  const maximumAddresses = Number(option("--maximum-addresses") ?? "100000");
  const datasetCutoff = option("--dataset-cutoff") ?? new Date().toISOString();
  const location = databaseLocation(root, candidate);
  const database = new ResearchDatabase(location);
  try {
    await database.migrate(
      fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
    );
    const startedAt = Date.now();
    const result = await database.refreshEntityActivityRollup(datasetCutoff, maximumAddresses);
    process.stdout.write(
      `${JSON.stringify(
        {
          authority: "READ_ONLY_DERIVED_RESEARCH",
          database: databaseDisplayLocation(location),
          elapsedMilliseconds: Date.now() - startedAt,
          ...result,
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
