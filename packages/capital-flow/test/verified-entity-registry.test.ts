import { describe, expect, it } from "vitest";
import { resolvePointInTimeAttribution, VerifiedEntityRegistryFileSchema } from "../src/index.js";

const record = {
  address: "11111111111111111111111111111111",
  entityType: "PROTOCOL" as const,
  label: "Solana System Program",
  source: "solana-program-library",
  sourceUrl: "https://github.com/solana-program/system",
  evidenceHash: `sha256:${"a".repeat(64)}` as const,
  validFrom: "2020-03-16T00:00:00.000Z",
  retrievedAt: "2026-10-03T12:00:00.000Z",
  schemaVersion: "1" as const,
};

describe("verified entity registry", () => {
  it("accepts explicit evidence-backed point-in-time records", () => {
    expect(
      VerifiedEntityRegistryFileSchema.parse({
        registryVersion: "1",
        generatedAt: "2026-10-03T12:00:00.000Z",
        records: [record],
      }).records[0]?.label,
    ).toBe("Solana System Program");
  });

  it("rejects duplicate address validity identities", () => {
    expect(() =>
      VerifiedEntityRegistryFileSchema.parse({
        registryVersion: "1",
        generatedAt: "2026-10-03T12:00:00.000Z",
        records: [record, record],
      }),
    ).toThrow(/duplicate/);
  });

  it("rejects later knowledge from historical attribution", () => {
    const later = { ...record, retrievedAt: "2026-10-04T00:00:00.000Z" };
    expect(
      resolvePointInTimeAttribution([later], record.address, "2026-10-03T23:59:59.000Z").status,
    ).toBe("UNKNOWN");
  });

  it("retains and exposes conflicting point-in-time claims", () => {
    const conflict = {
      ...record,
      entityType: "EXCHANGE" as const,
      label: "Conflicting claim",
      evidenceHash: `sha256:${"b".repeat(64)}` as const,
    };
    const resolution = resolvePointInTimeAttribution(
      [record, conflict],
      record.address,
      "2026-10-05T00:00:00.000Z",
    );
    expect(resolution.status).toBe("CONFLICT");
    expect(resolution.applicableClaims).toHaveLength(2);
    expect(resolution.conflictingClaims).toHaveLength(1);
  });
});
