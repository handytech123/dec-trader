import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const foundationMigration = new URL(
  "../../../infra/postgres/migrations/0001_phase_1_data_foundation.sql",
  import.meta.url,
);
const capitalFlowMigration = new URL(
  "../../../infra/postgres/migrations/0009_capital_flow_intelligence.sql",
  import.meta.url,
);
const enrichmentMigration = new URL(
  "../../../infra/postgres/migrations/0010_enrichment_claims.sql",
  import.meta.url,
);
const marketEvidenceMigration = new URL(
  "../../../infra/postgres/migrations/0012_market_events_and_evidence.sql",
  import.meta.url,
);

describe("capital-flow migration", () => {
  it("executes after the foundation and keeps published entities immutable", async () => {
    // Test-local URLs are constants under the repository migration directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const foundation = await readFile(foundationMigration, "utf8");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const capitalFlow = await readFile(capitalFlowMigration, "utf8");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const enrichment = await readFile(enrichmentMigration, "utf8");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const marketEvidence = await readFile(marketEvidenceMigration, "utf8");
    const database = new PGlite();
    await database.exec(foundation);
    await database.exec(capitalFlow);
    await database.exec(enrichment);
    await database.exec(marketEvidence);
    await database.query(
      `INSERT INTO entities
       (entity_id, entity_type, labels, addresses, attribution, confidence, first_seen, last_seen,
        evidence, schema_version, record_hash)
       VALUES ($1, 'EXCHANGE', '[]', '[]', 'UNKNOWN', 0, $2, $2, '[]', 1, $3)`,
      ["entity_01ARZ3NDEKTSV4RRFFQ69G5FAW", "2026-01-01T00:00:00.000Z", `sha256:${"a".repeat(64)}`],
    );
    await expect(database.query("UPDATE entities SET confidence = 1")).rejects.toThrow("immutable");
    await database.close();
  });
});
