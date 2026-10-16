import { describe, expect, it } from "vitest";
import { deterministicDomainId } from "@autonomous-trading-lab/domain";
import {
  createFlowConfirmedMomentumStrategy,
  createPostFlowContinuationStrategy,
  createPostFlowReversalStrategy,
  type EvidenceGatedStrategyConfig,
} from "../src/index.js";

const context = {
  evaluationId: deterministicDomainId("evaluation", "flow-strategies"),
  evaluatedAt: "2026-10-13T20:00:00.000Z",
  mode: "SHADOW" as const,
  portfolioSnapshotId: deterministicDomainId("portfolio", "flow-strategies"),
  featureSnapshotId: deterministicDomainId("feature", "flow-strategies"),
};
const base: EvidenceGatedStrategyConfig = {
  strategyVersionId: deterministicDomainId("strategy_version", "flow-strategy-v1"),
  experimentId: deterministicDomainId("experiment", "flow-strategy-v1"),
  inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  outputMint: "So11111111111111111111111111111111111111112",
  requestedInputAtomic: "1000000",
  minimumExpectedNetBps: 10,
  minimumEvidenceSampleSize: 100,
  minimumReplayReproducibility: 0.95,
  proposalLifetimeSeconds: 60,
};
const evidence = {
  evidenceVerdict: "SUPPORTED",
  evidenceSampleSize: 150,
  expectedNetBps: 20,
  replayReproducibility: 0.99,
};

describe("CFIE flow-confirmed momentum candidate", () => {
  const strategy = createFlowConfirmedMomentumStrategy({
    ...base,
    minimumReturn5mBps: 20,
    minimumVolumeAcceleration: 1.2,
    minimumLiquidityScore: 0.7,
    maximumSpreadBps: 25,
    minimumProtocolFlowZScore: 2,
  });

  it("proposes only when price, volume, liquidity, and flow agree", () => {
    const result = strategy.evaluate({
      context,
      features: {
        ...evidence,
        marketRegime: "RISING",
        return5mBps: 25,
        volumeAcceleration: 1.4,
        liquidityScore: 0.8,
        spreadBps: 10,
        protocolFlowZScore: 2.5,
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ thesisCode: "FLOW_CONFIRMED_MOMENTUM_V1" });
  });

  it("abstains when independent flow confirmation is absent", () => {
    expect(
      strategy.evaluate({
        context,
        features: {
          ...evidence,
          marketRegime: "RISING",
          return5mBps: 25,
          volumeAcceleration: 1.4,
          liquidityScore: 0.8,
          spreadBps: 10,
          protocolFlowZScore: 0.5,
        },
      }),
    ).toEqual([]);
  });
});

describe("CFIE post-flow continuation candidate", () => {
  const strategy = createPostFlowContinuationStrategy({
    ...base,
    minimumFlowMagnitudeZScore: 2,
    minimumConfirmationReturnBps: 10,
    minimumVolumeAcceleration: 1.2,
    minimumOrderBookImbalance: 0.1,
    minimumLiquidityScore: 0.7,
    maximumSpreadBps: 25,
  });

  it("proposes after a large inflow receives price and book confirmation", () => {
    const result = strategy.evaluate({
      context,
      features: {
        ...evidence,
        flowDirection: "INFLOW",
        flowMagnitudeZScore: 3,
        confirmationReturnBps: 15,
        volumeAcceleration: 1.3,
        orderBookImbalance: 0.2,
        liquidityScore: 0.8,
        spreadBps: 12,
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ thesisCode: "POST_FLOW_CONTINUATION_V1" });
  });

  it("abstains when the flow direction is not an inflow", () => {
    expect(
      strategy.evaluate({
        context,
        features: {
          ...evidence,
          flowDirection: "OUTFLOW",
          flowMagnitudeZScore: 3,
          confirmationReturnBps: 15,
          volumeAcceleration: 1.3,
          orderBookImbalance: 0.2,
          liquidityScore: 0.8,
          spreadBps: 12,
        },
      }),
    ).toEqual([]);
  });
});

describe("CFIE post-flow reversal candidate", () => {
  const strategy = createPostFlowReversalStrategy({
    ...base,
    minimumFlowMagnitudeZScore: 2,
    maximumShockReturnBps: -40,
    minimumRecoveryReturnBps: 10,
    minimumOrderBookImbalance: 0.1,
    minimumLiquidityScore: 0.7,
    maximumSpreadBps: 25,
  });

  it("proposes when an outflow shock begins a liquid, buy-supported recovery", () => {
    const result = strategy.evaluate({
      context,
      features: {
        ...evidence,
        flowDirection: "OUTFLOW",
        flowMagnitudeZScore: 3,
        shockReturnBps: -55,
        recoveryReturnBps: 15,
        orderBookImbalance: 0.2,
        liquidityScore: 0.8,
        spreadBps: 12,
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ thesisCode: "POST_FLOW_REVERSAL_V1" });
  });

  it("abstains until the shock demonstrates a recovery", () => {
    expect(
      strategy.evaluate({
        context,
        features: {
          ...evidence,
          flowDirection: "OUTFLOW",
          flowMagnitudeZScore: 3,
          shockReturnBps: -55,
          recoveryReturnBps: -5,
          orderBookImbalance: 0.2,
          liquidityScore: 0.8,
          spreadBps: 12,
        },
      }),
    ).toEqual([]);
  });
});
