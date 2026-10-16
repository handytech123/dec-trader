import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VerifiedEntityRegistryFileSchema,
  auditVerifiedEntityRegistry,
} from "@autonomous-trading-lab/capital-flow";
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
  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  const databasePath = databaseLocation(
    invocationDirectory,
    process.env.CFIE_DATABASE_URL ?? requiredOption("--database"),
  );
  const registryPath = resolve(invocationDirectory, requiredOption("--registry"));
  // The operator explicitly selects a local registry file; its contents are validated below.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const registryJson = await readFile(registryPath, "utf8");
  const registry = VerifiedEntityRegistryFileSchema.parse(JSON.parse(registryJson));
  const audit = auditVerifiedEntityRegistry(registry.records);
  if (!audit.safeToImport)
    throw new Error(
      `entity registry has ${String(audit.conflictingOverlapCount)} conflicting overlap(s)`,
    );
  if (process.argv.includes("--audit-only")) {
    process.stdout.write(
      `${JSON.stringify({ registryVersion: registry.registryVersion, auditOnly: true, audit })}\n`,
    );
    return;
  }
  const database = new ResearchDatabase(databasePath);
  let result: { readonly accepted: number; readonly inserted: number };
  try {
    await database.migrate(
      fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
    );
    result = await database.persistVerifiedEntityAddresses(registry.records);
  } finally {
    await database.close();
  }
  process.stdout.write(
    `${JSON.stringify({ registryVersion: registry.registryVersion, ...result, audit })}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
