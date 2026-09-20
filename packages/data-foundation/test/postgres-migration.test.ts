import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migrationPath = new URL(
  "../../../infra/postgres/migrations/0001_phase_1_data_foundation.sql",
  import.meta.url,
);

describe("PostgreSQL migration", () => {
  it("executes transactionally and enforces published-record immutability", async () => {
    // Test-local URL is a constant under the repository migration directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const migration = await readFile(migrationPath, "utf8");
    const database = new PGlite();
    await database.exec(migration);
    const hash = (character: string) => `sha256:${character.repeat(64)}`;
    await database.query(
      `INSERT INTO feature_definitions
       (feature_definition_id, name, version, units, window_spec, sources, null_behavior,
        freshness_limit_seconds, code_hash, config_hash, content_hash, published_at)
       VALUES ($1, $2, 1, $3, $4, $5, 'REJECT', 15, $6, $7, $8, $9)`,
      [
        "feature_01K5J8R4K4F8D8P9Q2Z2T2H3M4",
        "momentum_5m",
        "ratio",
        "5m",
        JSON.stringify(["synthetic"]),
        hash("a"),
        hash("b"),
        hash("c"),
        "2026-01-01T00:00:00.000Z",
      ],
    );
    await expect(
      database.query("UPDATE feature_definitions SET units = 'percent' WHERE name = 'momentum_5m'"),
    ).rejects.toThrow("immutable");
    await database.close();
  });
});
