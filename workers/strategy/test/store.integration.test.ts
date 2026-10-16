import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deterministicDomainId } from "@autonomous-trading-lab/domain";
import { ResearchDatabase } from "@autonomous-trading-lab/ingestion";
import { StrategyProposalService } from "../src/service.js";
import { PostgresStrategyStore } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("strategy store", () => {
  it("persists an idempotent no-trade evaluation through the leased queue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cfie-strategy-"));
    temporaryDirectories.push(directory);
    const migrations = new ResearchDatabase(directory);
    await migrations.migrate(resolve(process.cwd(), "infra/postgres/migrations"));
    await migrations.close();
    const store = new PostgresStrategyStore(directory);
    try {
      expect(
        await store.enqueueLatestCfieResearchSnapshot([
          deterministicDomainId("strategy_version", "unregistered-research-candidate"),
        ]),
      ).toEqual([]);
      const strategyVersionId = await store.registerStrategy({
        strategyId: "NO_TRADE_BASELINE",
        version: "1",
        status: "SHADOW_ELIGIBLE",
        moduleKey: "NO_TRADE_BASELINE_V1",
        configuration: { purpose: "pipeline-control" },
        registeredAt: "2026-10-12T00:00:00.000Z",
      });
      const snapshot = {
        featureSnapshotId: deterministicDomainId("feature", "integration-feature"),
        portfolioSnapshotId: deterministicDomainId("portfolio", "integration-portfolio"),
        observedAt: "2026-10-12T00:00:00.000Z",
        mode: "SHADOW" as const,
        features: { flowZScore: 0 },
        provenance: {
          pointInTimeVerified: true,
          latestSourceAt: "2026-10-11T23:59:30.000Z",
          maximumAgeSeconds: 60,
        },
        strategyVersionIds: [strategyVersionId],
      };
      const firstId = await store.enqueueSnapshot(snapshot);
      expect(await store.enqueueSnapshot(snapshot)).toBe(firstId);
      const service = new StrategyProposalService(
        store,
        new Map([["NO_TRADE_BASELINE_V1", { evaluate: () => [] }]]),
        "integration-owner",
      );
      expect(await service.runCycle()).toEqual({ claimed: 1, completed: 1, failed: 0 });
      expect(await service.runCycle()).toEqual({ claimed: 0, completed: 0, failed: 0 });
      expect(await store.status()).toEqual({
        pending: 0,
        processing: 0,
        complete: 1,
        failed: 0,
        evaluations: 1,
        proposals: 0,
      });
      expect(await store.comparison()).toEqual([
        {
          strategyId: "NO_TRADE_BASELINE",
          version: "1",
          status: "SHADOW_ELIGIBLE",
          evaluations: 1,
          proposals: 0,
          noTrades: 1,
          latestEvaluationAt: "2026-10-12T00:00:00.000Z",
        },
      ]);
    } finally {
      await store.close();
    }
  }, 20_000);
});
