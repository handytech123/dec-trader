import { describe, expect, it } from "vitest";
import { deterministicDomainId, type TradeProposal } from "@autonomous-trading-lab/domain";
import type {
  StrategyModule,
  StrategyProposalEvaluation,
} from "@autonomous-trading-lab/strategy-sdk";
import { StrategyProposalService } from "../src/service.js";
import type { StrategyJob, StrategyStore } from "../src/store.js";

const strategyVersionId = deterministicDomainId("strategy_version", "service-strategy");
const job: StrategyJob = {
  jobId: deterministicDomainId("strategy_job", "job"),
  snapshotId: deterministicDomainId("strategy_snapshot", "snapshot"),
  evaluationId: deterministicDomainId("evaluation", "evaluation"),
  strategyVersionId,
  strategyStatus: "PAPER_ELIGIBLE",
  moduleKey: "TEST",
  observedAt: "2026-10-12T00:00:00.000Z",
  asOfSlot: "123",
  mode: "PAPER",
  portfolioSnapshotId: deterministicDomainId("portfolio", "portfolio"),
  featureSnapshotId: deterministicDomainId("feature", "feature"),
  features: { flowZScore: 3 },
  provenance: {
    pointInTimeVerified: true,
    latestSourceAt: "2026-10-11T23:59:30.000Z",
    maximumAgeSeconds: 60,
  },
};

function proposal(): TradeProposal {
  return {
    proposalId: deterministicDomainId("proposal", "proposal"),
    strategyVersionId,
    experimentId: deterministicDomainId("experiment", "experiment"),
    side: "BUY",
    inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    outputMint: "So11111111111111111111111111111111111111112",
    requestedInputAtomic: "1000000",
    thesisCode: "TEST_V1",
    signalValues: { flowZScore: 3 },
    validUntil: "2026-10-12T00:05:00.000Z",
  };
}

class MemoryStore implements StrategyStore {
  public completed: StrategyProposalEvaluation | undefined;
  public failures: string[] = [];
  public constructor(private readonly jobs: readonly StrategyJob[]) {}
  public claimJobs(): Promise<readonly StrategyJob[]> {
    return Promise.resolve(this.jobs);
  }
  public completeJob(
    _job: StrategyJob,
    _ownerId: string,
    result: StrategyProposalEvaluation,
  ): Promise<void> {
    this.completed = result;
    return Promise.resolve();
  }
  public failJob(_jobId: string, _ownerId: string, error: string): Promise<void> {
    this.failures.push(error);
    return Promise.resolve();
  }
}

describe("strategy proposal service", () => {
  it("completes an eligible paper proposal", async () => {
    const store = new MemoryStore([job]);
    const module: StrategyModule = { evaluate: () => [proposal()] };
    const result = await new StrategyProposalService(
      store,
      new Map([["TEST", module]]),
      "owner",
    ).runCycle();
    expect(result).toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(store.completed?.decision).toBe("PROPOSE");
  });

  it("fails closed when a module is unavailable", async () => {
    const store = new MemoryStore([job]);
    const result = await new StrategyProposalService(store, new Map(), "owner").runCycle();
    expect(result).toEqual({ claimed: 1, completed: 0, failed: 1 });
    expect(store.failures[0]).toContain("module is unavailable");
  });

  it("does not route shadow-only strategies into paper evaluation", async () => {
    const store = new MemoryStore([{ ...job, strategyStatus: "SHADOW_ELIGIBLE" }]);
    const result = await new StrategyProposalService(
      store,
      new Map([["TEST", { evaluate: () => [] }]]),
      "owner",
    ).runCycle();
    expect(result.failed).toBe(1);
    expect(store.failures[0]).toContain("not eligible for evaluation");
  });

  it("evaluates research-only strategies only in backtest mode", async () => {
    const store = new MemoryStore([{ ...job, mode: "BACKTEST", strategyStatus: "RESEARCH_ONLY" }]);
    const result = await new StrategyProposalService(
      store,
      new Map([["TEST", { evaluate: () => [] }]]),
      "owner",
    ).runCycle();
    expect(result).toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(store.completed?.decision).toBe("NO_TRADE");
  });

  it("rejects stale snapshots before strategy evaluation", async () => {
    const store = new MemoryStore([
      {
        ...job,
        provenance: { ...job.provenance, latestSourceAt: "2026-10-11T23:00:00.000Z" },
      },
    ]);
    const result = await new StrategyProposalService(
      store,
      new Map([["TEST", { evaluate: () => [proposal()] }]]),
      "owner",
    ).runCycle();
    expect(result.failed).toBe(1);
    expect(store.failures[0]).toContain("stale");
  });
});
