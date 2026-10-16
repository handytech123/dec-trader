import { resolve } from "node:path";
import { ResearchDatabase } from "./database.js";
import { databaseDisplayLocation, databaseLocation } from "./database-location.js";

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const boundedInteger = (
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const value = Number(option(name) ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be between ${String(minimum)} and ${String(maximum)}`);
  return value;
};

async function main(): Promise<void> {
  if (!process.argv.includes("--materialize-episodes"))
    throw new Error("episode materialization requires --materialize-episodes");
  const root = process.env.INIT_CWD ?? process.cwd();
  const location = databaseLocation(
    root,
    process.env.CFIE_DATABASE_URL ?? option("--database") ?? ".atl-data/research-db",
  );
  const maximumBatches = boundedInteger("--maximum-batches", 1, 1, 1000);
  const maximumEpisodesPerBatch = boundedInteger("--maximum-episodes-per-batch", 1000, 1, 1000);
  const database = new ResearchDatabase(location);
  let episodesInserted = 0;
  let eventsGrouped = 0;
  let contextsInserted = 0;
  try {
    await database.migrate(resolve(root, "infra/postgres/migrations"));
    for (let batch = 0; batch < maximumBatches; batch += 1) {
      const result = await database.materializeCapitalFlowEpisodes({
        asOf: new Date().toISOString(),
        windowSeconds: 60,
        finalizationGraceSeconds: 120,
        maximumWindows: maximumEpisodesPerBatch,
      });
      episodesInserted += result.episodesInserted;
      eventsGrouped += result.eventsGrouped;
      const contexts = await database.materializeEpisodeProtocolContexts({
        asOf: new Date().toISOString(),
        maximumEpisodes: maximumEpisodesPerBatch,
      });
      contextsInserted += contexts.contextsInserted;
      if (result.episodesInserted === 0) break;
    }
    process.stdout.write(
      `${JSON.stringify({
        authority: "READ_ONLY_RESEARCH",
        database: databaseDisplayLocation(location),
        algorithmVersion: 2,
        episodesInserted,
        eventsGrouped,
        contextsInserted,
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
