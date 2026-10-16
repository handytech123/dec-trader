import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ResearchDatabase } from "../src/database.js";

const migrations = fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url));

describe("paper style laboratory persistence", () => {
  it("migrates an empty database and records a deterministic no-trade cycle", async () => {
    const database = new ResearchDatabase("memory://");
    try {
      await database.migrate(migrations);

      await expect(database.paperStyleLabReport()).resolves.toMatchObject({
        authority: "READ_ONLY_PAPER_LAB",
        mode: "PAPER_ONLY",
        counts: { profiles: 0, selections: 0, risk_verdicts: 0, fills: 0, portfolios: 0 },
        latestSelection: null,
        invariants: {
          walletAccess: false,
          signing: false,
          transactionSubmission: false,
          exchangeTrading: false,
          capitalAllocation: false,
        },
      });

      const result = await database.runPaperStyleLabCycle("2026-10-09T12:00:00.000Z");
      expect(result).toMatchObject({
        authority: "READ_ONLY_PAPER_LAB",
        mode: "PAPER_ONLY",
        trainingObservationCount: 0,
        decision: {
          mode: "PAPER_ONLY",
          decision: "NO_TRADE",
          selectedStyleId: null,
          reasons: ["NO_ELIGIBLE_STYLE"],
        },
      });

      const report = await database.paperStyleLabReport();
      expect(report).toMatchObject({
        counts: { profiles: 2, selections: 1, risk_verdicts: 0, fills: 0, portfolios: 0 },
        latestSelection: { decision: "NO_TRADE", selected_style_id: null },
      });
      expect(report.latestProfiles).toHaveLength(2);
    } finally {
      await database.close();
    }
  });

  it("deduplicates a repeated cycle at the same point in time", async () => {
    const database = new ResearchDatabase("memory://");
    try {
      await database.migrate(migrations);
      await database.runPaperStyleLabCycle("2026-10-09T12:00:00.000Z");
      await database.runPaperStyleLabCycle("2026-10-09T12:00:00.000Z");

      await expect(database.paperStyleLabReport()).resolves.toMatchObject({
        counts: { profiles: 2, selections: 1, risk_verdicts: 0, fills: 0, portfolios: 0 },
      });
    } finally {
      await database.close();
    }
  });
});
