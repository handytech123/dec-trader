import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  EntityRegistrySourceManifestSchema,
  fetchVerifiedEntityRegistry,
} from "./entity-registry-source.js";
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

async function main(): Promise<void> {
  const root = process.env.INIT_CWD ?? process.cwd();
  const manifestPath = resolve(root, requiredOption("--manifest"));
  // The operator explicitly selects a local manifest; its contents are validated below.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = EntityRegistrySourceManifestSchema.parse(JSON.parse(manifestText));
  const sync = await fetchVerifiedEntityRegistry({
    manifest,
    retrievedAt: new Date().toISOString(),
  });
  if (!sync.audit.safeToImport)
    throw new Error(`${String(sync.audit.conflictingOverlapCount)} source conflict(s) detected`);
  if (process.argv.includes("--audit-only")) {
    process.stdout.write(
      `${JSON.stringify({ mode: "ENTITY_REGISTRY_AUDIT", records: sync.records, audit: sync.audit, sourcesFetched: sync.sourcesFetched, bytesFetched: sync.bytesFetched, evidenceHashes: sync.sourceSnapshots.map((snapshot) => snapshot.evidenceHash) }, null, 2)}\n`,
    );
    return;
  }
  if (!process.argv.includes("--enable-entity-registry-write"))
    throw new Error("registry writes are disabled; pass --enable-entity-registry-write explicitly");
  const databasePath = databaseLocation(
    root,
    process.env.CFIE_DATABASE_URL ?? requiredOption("--database"),
  );
  const database = new ResearchDatabase(databasePath);
  try {
    await database.migrate(resolve(root, "infra/postgres/migrations"));
    let sourceSnapshotsInserted = 0;
    for (const snapshot of sync.sourceSnapshots)
      if (await database.persistEntitySourceSnapshot(snapshot)) sourceSnapshotsInserted += 1;
    const persisted = await database.persistVerifiedEntityAddresses(sync.records);
    process.stdout.write(
      `${JSON.stringify({ mode: "ENTITY_REGISTRY_SYNC", databasePath: databaseDisplayLocation(databasePath), persisted, sourceSnapshotsInserted, audit: sync.audit, sourcesFetched: sync.sourcesFetched, bytesFetched: sync.bytesFetched }, null, 2)}\n`,
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
