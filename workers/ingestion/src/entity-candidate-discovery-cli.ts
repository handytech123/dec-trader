import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ResearchDatabase } from "./database.js";
import { databaseDisplayLocation, databaseLocation } from "./database-location.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function integerOption(name: string, fallback: number): number {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

async function main(): Promise<void> {
  if (!process.argv.includes("--discover-entity-candidates"))
    throw new Error("--discover-entity-candidates is required");
  const root = process.env.INIT_CWD ?? process.cwd();
  const candidate = process.env.CFIE_DATABASE_URL ?? option("--database");
  if (!candidate) throw new Error("--database or CFIE_DATABASE_URL is required");
  const location = databaseLocation(root, candidate);
  const asOf = option("--as-of") ?? new Date().toISOString();
  const minimumEventCount = integerOption("--minimum-event-count", 100);
  const limit = integerOption("--limit", 100);
  const database = new ResearchDatabase(location);
  try {
    await database.migrate(resolve(root, "infra/postgres/migrations"));
    const startedAt = Date.now();
    const candidates = await database.entityVerificationCandidates(asOf, minimumEventCount, limit);
    const report = {
      authority: "READ_ONLY_ENTITY_DISCOVERY",
      database: databaseDisplayLocation(location),
      asOf,
      minimumEventCount,
      limit,
      elapsedMilliseconds: Date.now() - startedAt,
      candidateCount: candidates.length,
      verifiedCount: candidates.filter((entry) => entry.identityStatus === "VERIFIED").length,
      warning:
        "Behavior labels are heuristics, not identity claims. UNKNOWN remains UNKNOWN until supported by sourced evidence.",
      candidates,
    };
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    const output = option("--output");
    // Explicit operator-selected report path; report generation is the command's intended write.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (output) await writeFile(resolve(root, output), serialized, "utf8");
    process.stdout.write(serialized);
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
