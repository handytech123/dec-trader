import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { ResearchDatabase } from "../src/database.js";
import { EntityVerificationReviewSchema } from "../src/entity-review.js";

const base = {
  address: "11111111111111111111111111111111",
  decidedAt: "2026-10-05T12:00:00.000Z",
  reviewer: "operator",
  rationale: "Awaiting authoritative evidence.",
};

describe("entity verification review", () => {
  it("allows pending decisions without pretending an identity is known", () => {
    expect(EntityVerificationReviewSchema.parse({ ...base, status: "PENDING" }).status).toBe(
      "PENDING",
    );
  });

  it("requires complete provenance for a verified decision", () => {
    expect(() => EntityVerificationReviewSchema.parse({ ...base, status: "VERIFIED" })).toThrow();
    expect(
      EntityVerificationReviewSchema.parse({
        ...base,
        status: "VERIFIED",
        proposedEntityType: "PROTOCOL",
        proposedLabel: "System Program",
        source: "official",
        sourceUrl: "https://solana.com/docs",
        evidenceHash: `sha256:${"a".repeat(64)}`,
        validFrom: "2020-03-16T00:00:00.000Z",
      }).status,
    ).toBe("VERIFIED");
  });

  it("persists append-only pending review history", async () => {
    const database = new ResearchDatabase("memory://");
    try {
      await database.migrate(
        fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
      );
      const pending = EntityVerificationReviewSchema.parse({ ...base, status: "PENDING" });
      expect(await database.persistEntityVerificationReview(pending)).toBe(true);
      expect(await database.persistEntityVerificationReview(pending)).toBe(false);
      expect((await database.latestEntityVerificationReviews())[0]?.status).toBe("PENDING");
      await expect(
        database.persistEntityVerificationReview({
          ...pending,
          status: "VERIFIED",
          proposedEntityType: "PROTOCOL",
          proposedLabel: "System Program",
          source: "official",
          sourceUrl: "https://solana.com/docs",
          evidenceHash: `sha256:${"a".repeat(64)}`,
          validFrom: "2020-03-16T00:00:00.000Z",
        }),
      ).rejects.toThrow("matching imported");
    } finally {
      await database.close();
    }
  });
});
