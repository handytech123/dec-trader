import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../infra/postgres/migrations/", import.meta.url));
const migrations = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
if (migrations.length === 0) throw new Error("at least one PostgreSQL migration is required");

const requiredTables = [
  "assets",
  "raw_observations",
  "market_observations",
  "feature_definitions",
  "feature_snapshots",
  "strategy_definitions",
  "strategy_versions",
  "experiments",
  "evaluations",
  "trade_proposals",
];

const combined = (
  await Promise.all(migrations.map((file) => readFile(join(directory, file), "utf8")))
).join("\n");
if (!combined.startsWith("BEGIN;") || !combined.trimEnd().endsWith("COMMIT;")) {
  throw new Error("migrations must be transactional");
}
for (const table of requiredTables) {
  // Table names come only from the constant allowlist above.
  // eslint-disable-next-line security/detect-non-literal-regexp
  if (!new RegExp(`CREATE TABLE ${table}\\s*\\(`).test(combined))
    throw new Error(`missing table ${table}`);
}
if (/\b(real|double precision|float)\b/i.test(combined)) {
  throw new Error("binary floating-point types are forbidden for persisted financial data");
}
if (!combined.includes("reject_published_record_mutation")) {
  throw new Error("immutable published-record enforcement is missing");
}
console.log(`Validated ${migrations.length} transactional PostgreSQL migration(s).`);
