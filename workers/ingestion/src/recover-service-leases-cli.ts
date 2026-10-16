import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { ResearchDatabase } from "./database.js";
import { databaseLocation } from "./database-location.js";

const ManifestSchema = z.object({ serviceName: z.string().min(1), ownerId: z.uuid() });

async function main(): Promise<void> {
  if (!process.argv.includes("--recover-supervisor-handoff"))
    throw new Error("lease recovery requires --recover-supervisor-handoff");
  const root = process.env.INIT_CWD ?? process.cwd();
  const database = new ResearchDatabase(
    databaseLocation(root, process.env.CFIE_DATABASE_URL ?? ".atl-data/research-db"),
  );
  const manifestPaths = [
    resolve(root, ".atl-data/cfie-service-postgres/collection-service.json"),
    resolve(root, ".atl-data/cfie-service-postgres/derivation-service.json"),
  ];
  try {
    const recovered: { serviceName: string; released: boolean }[] = [];
    for (const path of manifestPaths) {
      // Paths are fixed workspace-owned operational manifests.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const manifest = ManifestSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
      recovered.push({
        serviceName: manifest.serviceName,
        released: await database.releaseCollectionServiceLease(
          manifest.serviceName,
          manifest.ownerId,
          new Date().toISOString(),
          "STOPPED",
          "SUPERVISOR_HANDOFF_RECOVERY",
        ),
      });
    }
    process.stdout.write(`${JSON.stringify({ authority: "READ_ONLY_OPERATIONS", recovered })}\n`);
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
