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
  if (!process.argv.includes("--compute-market-reactions"))
    throw new Error("market-reaction computation requires --compute-market-reactions");
  const root = process.env.INIT_CWD ?? process.cwd();
  const databasePath = databaseLocation(
    root,
    process.env.CFIE_DATABASE_URL ?? requiredOption("--database"),
  );
  const venue = requiredOption("--venue");
  const instrumentId = requiredOption("--instrument-id");
  const windowSeconds = integerOption("--window-seconds", 60, 60, 86_400);
  const maximumEvents = integerOption("--maximum-events", 1000, 1, 10_000);
  const maximumSnapshotAgeSeconds = integerOption("--maximum-snapshot-age-seconds", 60, 1, 3600);
  const asOf = option("--as-of") ?? new Date().toISOString();
  const database = new ResearchDatabase(databasePath);
  let completed = 0;
  const failures: { readonly eventId: string; readonly error: string }[] = [];
  try {
    await database.migrate(resolve(root, "infra/postgres/migrations"));
    const eventIds = await database.pendingMarketReactionEventIds({
      venue,
      instrumentId,
      windowSeconds,
      asOf,
      maximumEvents,
      maximumSnapshotAgeSeconds,
    });
    for (const eventId of eventIds) {
      try {
        await database.computeAndPersistMarketReaction({
          capitalEventId: eventId,
          venue,
          instrumentId,
          windowSeconds,
          maximumSnapshotAgeSeconds,
        });
        completed += 1;
      } catch (error: unknown) {
        failures.push({ eventId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    process.stdout.write(
      `${JSON.stringify({
        authority: "READ_ONLY_RESEARCH",
        databasePath: databaseDisplayLocation(databasePath),
        asOf,
        venue,
        instrumentId,
        windowSeconds,
        candidates: eventIds.length,
        completed,
        failed: failures.length,
        failures: failures.slice(0, 20),
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
