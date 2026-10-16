import { describe, expect, it } from "vitest";
import { deterministicDomainId, type TradeProposal } from "@autonomous-trading-lab/domain";
import {
  allocatePaperPortfolio,
  executePaperOrder,
  falsifyProposal,
  paperRiskGate,
  reconcilePaperExecution,
  runPaperAgentPipeline,
  supervisePaperPipeline,
} from "../src/index.js";

const proposal: TradeProposal = {
  proposalId: deterministicDomainId("proposal", "agents"),
  strategyVersionId: deterministicDomainId("strategy_version", "agents"),
  experimentId: deterministicDomainId("experiment", "agents"),
  side: "BUY",
  inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  outputMint: "So11111111111111111111111111111111111111112",
  requestedInputAtomic: "1000000",
  thesisCode: "TEST",
  signalValues: {},
  validUntil: "2026-10-12T00:05:00.000Z",
};

const strongEvidence = {
  sampleSize: 200,
  holdoutExpectancyBps: 25,
  randomizedBaselineBps: 2,
  stressedCostBps: 15,
  outlierRemovedExpectancyBps: 18,
  replayReproducibility: 0.99,
  pointInTimeVerified: true,
};

describe("responsibility-separated paper agents", () => {
  it("falsification can veto but never authorize", () => {
    expect(falsifyProposal(proposal, strongEvidence).outcome).toBe("SURVIVES");
    expect(
      falsifyProposal(proposal, { ...strongEvidence, pointInTimeVerified: false }).outcome,
    ).toBe("REJECTED");
  });

  it("portfolio allocation de-correlates and respects its paper budget", () => {
    const verdict = falsifyProposal(proposal, strongEvidence);
    const second = { ...proposal, proposalId: deterministicDomainId("proposal", "second") };
    const decision = allocatePaperPortfolio(
      [
        {
          proposal,
          falsification: verdict,
          expectedNetBps: 20,
          correlationGroup: "SOL",
          requestedNotionalUsd: 10,
        },
        {
          proposal: second,
          falsification: verdict,
          expectedNetBps: 10,
          correlationGroup: "SOL",
          requestedNotionalUsd: 10,
        },
      ],
      10,
    );
    expect(decision.selected.map((candidate) => candidate.proposal.proposalId)).toEqual([
      proposal.proposalId,
    ]);
    expect(decision.totalNotionalUsd).toBe(10);
  });

  it("risk, simulated execution, and reconciliation remain paper-only", () => {
    const candidate = {
      proposal,
      falsification: falsifyProposal(proposal, strongEvidence),
      expectedNetBps: 20,
      correlationGroup: "SOL",
      requestedNotionalUsd: 10,
    };
    const risk = paperRiskGate({
      limits: {
        policyVersion: "paper-v1",
        maximumTradeNotionalUsd: 10,
        maximumAssetExposureUsd: 20,
        maximumPortfolioDrawdownPct: 5,
        maximumDailyLossUsd: 10,
        maximumMarketDataAgeSeconds: 5,
      },
      snapshot: {
        evaluatedAt: "2026-10-12T00:00:00.000Z",
        marketDataAgeSeconds: 1,
        portfolioDrawdownPct: 0,
        dailyPnlUsd: 0,
        currentAssetExposureUsd: 0,
      },
      proposal: candidate,
    });
    expect(risk.outcome).toBe("APPROVED_FOR_PAPER_FILL");
    const execution = executePaperOrder(
      {
        orderId: "paper-order-1",
        inputAtomic: "1000000",
        quotedOutputAtomic: "5000000",
        availableLiquidityInputAtomic: "1000000",
        priceImpactBps: 10,
        slippageBps: 10,
        decidedAt: "2026-10-12T00:00:00.000Z",
        quoteExpiresAt: "2026-10-12T00:01:00.000Z",
        deterministicFailureDrawBps: 9999,
      },
      {
        modelVersion: "paper-fill-v1",
        decisionToQuoteLatencyMs: 100,
        quoteToSubmitLatencyMs: 100,
        routeFeeBps: 10,
        networkFeeAtomic: "5000",
        baseFailureBps: 0,
        stressMultiplier: "1",
      },
    );
    expect(execution.authority).toBe("SIMULATION_ONLY");
    const reconciled = reconcilePaperExecution({
      portfolio: { portfolioId: "paper", version: 0, balancesAtomic: { USDC: "1000000" } },
      inputAsset: "USDC",
      outputAsset: "SOL",
      execution,
    });
    expect(reconciled.status).toBe("APPLIED");
  });

  it("supervisor halts on any failed invariant", () => {
    expect(
      supervisePaperPipeline({
        collectorsHealthy: true,
        dataFresh: false,
        accountingReconciled: true,
        failureCount: 0,
        maximumFailures: 1,
      }),
    ).toEqual({ mode: "PAPER_ONLY", outcome: "HALT", reasons: ["STALE_DATA"] });
  });

  it("runs the complete paper chain with an auditable terminal result", () => {
    const result = runPaperAgentPipeline({
      candidate: {
        proposal,
        falsification: falsifyProposal(proposal, strongEvidence),
        expectedNetBps: 20,
        correlationGroup: "SOL",
        requestedNotionalUsd: 10,
      },
      evidence: strongEvidence,
      portfolioBudgetUsd: 10,
      riskLimits: {
        policyVersion: "paper-v1",
        maximumTradeNotionalUsd: 10,
        maximumAssetExposureUsd: 20,
        maximumPortfolioDrawdownPct: 5,
        maximumDailyLossUsd: 10,
        maximumMarketDataAgeSeconds: 5,
      },
      riskSnapshot: {
        evaluatedAt: "2026-10-12T00:00:00.000Z",
        marketDataAgeSeconds: 1,
        portfolioDrawdownPct: 0,
        dailyPnlUsd: 0,
        currentAssetExposureUsd: 0,
      },
      order: {
        orderId: "paper-pipeline-order",
        inputAtomic: "1000000",
        quotedOutputAtomic: "5000000",
        availableLiquidityInputAtomic: "1000000",
        priceImpactBps: 10,
        slippageBps: 10,
        decidedAt: "2026-10-12T00:00:00.000Z",
        quoteExpiresAt: "2026-10-12T00:01:00.000Z",
        deterministicFailureDrawBps: 9999,
      },
      fillModel: {
        modelVersion: "paper-v1",
        decisionToQuoteLatencyMs: 100,
        quoteToSubmitLatencyMs: 100,
        routeFeeBps: 10,
        networkFeeAtomic: "5000",
        baseFailureBps: 0,
        stressMultiplier: "1",
      },
      portfolio: {
        portfolioId: "paper",
        version: 0,
        balancesAtomic: { [proposal.inputMint]: "1000000" },
      },
      supervisor: {
        collectorsHealthy: true,
        dataFresh: true,
        accountingReconciled: true,
        failureCount: 0,
        maximumFailures: 1,
      },
    });
    expect(result.outcome).toBe("SIMULATED_AND_RECONCILED");
    expect(result.authority).toBe("PAPER_ONLY_NO_EXECUTION");
    expect(result.traceHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
