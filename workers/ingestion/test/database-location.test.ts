import { describe, expect, it } from "vitest";
import { databaseDisplayLocation, databaseLocation } from "../src/database-location.js";

describe("database location", () => {
  it("preserves PostgreSQL URLs and resolves local database directories", () => {
    expect(databaseLocation("C:\\workspace", "postgresql://user:secret@localhost/cfie")).toBe(
      "postgresql://user:secret@localhost/cfie",
    );
    expect(databaseLocation("C:\\workspace", ".atl-data/research-db")).toBe(
      "C:\\workspace\\.atl-data\\research-db",
    );
  });

  it("removes PostgreSQL credentials from display output", () => {
    expect(
      databaseDisplayLocation("postgresql://user:secret@localhost:5432/cfie?sslmode=require"),
    ).toBe("postgresql://localhost:5432/cfie");
  });
});
