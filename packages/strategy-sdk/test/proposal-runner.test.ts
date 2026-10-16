import { describe, expect, it } from "vitest";
import { deterministicDomainId, type TradeProposal } from "@autonomous-trading-lab/domain";
import { runStrategyProposalEvaluation, type StrategyModule } from "../src/index.js";

const ids = {
  evaluation: deterministicDomainId("evaluation", "evaluation-1"),
  portfolio: deterministicDomainId("portfolio", "portfolio-1"),
  feature: deterministicDomainId("feature", "feature-1"),
  strategy: deterministicDomainId("strategy_version", "strategy-1"),
  experiment: deterministicDomainId("experiment", "experiment-1"),
  proposal: deterministicDomainId("proposal", "proposal-1"),
};

const context = {
  evaluationId: ids.evaluation,
  evaluatedAt: "2026-10-12T00:00:00.000Z",
  mode: "PAPER" as const,
  portfolioSnapshotId: ids.portfolio,
  featureSnapshotId: ids.feature,
};

const sol = "So11111111111111111111111111111111111111112";
const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function proposal(overrides: Partial<TradeProposal> = {}): TradeProposal {
  return {
    proposalId: ids.proposal,
    strategyVersionId: ids.strategy,
    experimentId: ids.experiment,
    side: "BUY",
    inputMint: usdc,
    outputMint: sol,
    requestedInputAtomic: "1000000",
    thesisCode: "CFIE_FLOW_SIGNAL_V1",
    signalValues: { flowZScore: 2.4, regime: "RISING" },
    confidence: 0.7,
    validUntil: "2026-10-12T00:05:00.000Z",
    ...overrides,
  };
}

describe("strategy proposal runner", () => {
  it("records an explicit no-trade decision", async () => {
    const module: StrategyModule = { evaluate: () => [] };
    const result = await runStrategyProposalEvaluation(module, {
      strategyVersionId: ids.strategy,
      context,
      features: { flowZScore: 0.2 },
    });
    expect(result).toMatchObject({
      authority: "PAPER_PROPOSAL_ONLY",
      decision: "NO_TRADE",
      reasons: ["NO_ELIGIBLE_SIGNAL"],
      proposals: [],
      proposalHashes: [],
    });
  });

  it("validates and hashes a paper proposal", async () => {
    const module: StrategyModule = { evaluate: () => [proposal()] };
    const result = await runStrategyProposalEvaluation(module, {
      strategyVersionId: ids.strategy,
      context,
      features: { flowZScore: 2.4 },
    });
    expect(result.decision).toBe("PROPOSE");
    expect(result.proposals).toHaveLength(1);
    expect(result.inputHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.proposalHashes[0]).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects live mode before invoking the strategy", async () => {
    let invoked = false;
    const module: StrategyModule = {
      evaluate: () => {
        invoked = true;
        return [];
      },
    };
    await expect(
      runStrategyProposalEvaluation(module, {
        strategyVersionId: ids.strategy,
        context: { ...context, mode: "LIVE" },
        features: {},
      }),
    ).rejects.toThrow("live strategy evaluation is unavailable");
    expect(invoked).toBe(false);
  });

  it.each([
    ["wrong strategy", { strategyVersionId: deterministicDomainId("strategy_version", "other") }],
    ["zero amount", { requestedInputAtomic: "0" }],
    ["same mint", { inputMint: sol, outputMint: sol }],
    ["expired", { validUntil: context.evaluatedAt }],
  ])("rejects an invalid proposal: %s", async (_label, overrides) => {
    const module: StrategyModule = { evaluate: () => [proposal(overrides)] };
    await expect(
      runStrategyProposalEvaluation(module, {
        strategyVersionId: ids.strategy,
        context,
        features: {},
      }),
    ).rejects.toThrow();
  });

  it("rejects duplicate proposal identities", async () => {
    const module: StrategyModule = { evaluate: () => [proposal(), proposal()] };
    await expect(
      runStrategyProposalEvaluation(module, {
        strategyVersionId: ids.strategy,
        context,
        features: {},
      }),
    ).rejects.toThrow("duplicate proposal IDs");
  });
});
