import { describe, expect, it } from "vitest";
import { deterministicDomainId } from "@autonomous-trading-lab/domain";
import {
  createCrossVenueDislocationStrategy,
  createFlowAwareMeanReversionStrategy,
  createLiquidityConfirmedBreakoutStrategy,
  type EvidenceGatedStrategyConfig,
} from "../src/index.js";

const context = {
  evaluationId: deterministicDomainId("evaluation", "market-strategies"),
  evaluatedAt: "2026-10-13T21:00:00.000Z",
  mode: "SHADOW" as const,
  portfolioSnapshotId: deterministicDomainId("portfolio", "market-strategies"),
  featureSnapshotId: deterministicDomainId("feature", "market-strategies"),
};
const base: EvidenceGatedStrategyConfig = {
  strategyVersionId: deterministicDomainId("strategy_version", "market-strategy-v1"),
  experimentId: deterministicDomainId("experiment", "market-strategy-v1"),
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

describe("liquidity-confirmed breakout candidate", () => {
  const strategy = createLiquidityConfirmedBreakoutStrategy({
    ...base,
    minimumBreakoutBps: 30,
    minimumVolumeAcceleration: 1.3,
    minimumDepthRetentionScore: 0.75,
    minimumVenueConfirmations: 2,
    minimumLiquidityScore: 0.7,
    maximumSpreadBps: 25,
  });
  const qualifying = {
    ...evidence,
    marketRegime: "RISING",
    breakoutBps: 40,
    volumeAcceleration: 1.5,
    depthRetentionScore: 0.8,
    venueConfirmations: 2,
    liquidityScore: 0.8,
    spreadBps: 12,
  };

  it("proposes only after a liquid multi-venue breakout", () => {
    const result = strategy.evaluate({ context, features: qualifying });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ thesisCode: "LIQUIDITY_CONFIRMED_BREAKOUT_V1" });
  });

  it("abstains when only one venue confirms the move", () => {
    expect(
      strategy.evaluate({ context, features: { ...qualifying, venueConfirmations: 1 } }),
    ).toEqual([]);
  });
});

describe("cross-venue dislocation candidate", () => {
  const strategy = createCrossVenueDislocationStrategy({
    ...base,
    minimumDexDiscountBps: 40,
    minimumExecutableEdgeBps: 15,
    minimumReferenceConfidence: 0.9,
    maximumQuoteAgeMs: 2_000,
    maximumEstimatedCostBps: 30,
  });
  const qualifying = {
    ...evidence,
    referenceVenueCount: 2,
    dexDiscountBps: 55,
    executableEdgeBps: 25,
    referenceConfidence: 0.95,
    quoteAgeMs: 500,
    estimatedTotalCostBps: 20,
  };

  it("proposes only for a fresh discount that survives estimated costs", () => {
    const result = strategy.evaluate({ context, features: qualifying });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ thesisCode: "CROSS_VENUE_DISLOCATION_V1" });
  });

  it("abstains when the executable quote is stale", () => {
    expect(strategy.evaluate({ context, features: { ...qualifying, quoteAgeMs: 2_001 } })).toEqual(
      [],
    );
  });
});

describe("flow-aware mean-reversion candidate", () => {
  const strategy = createFlowAwareMeanReversionStrategy({
    ...base,
    minimumNegativeDeviationBps: 50,
    minimumRecoveryBps: 10,
    minimumProtocolFlowZScore: 0,
    minimumLiquidityScore: 0.75,
    maximumSpreadBps: 20,
  });
  const qualifying = {
    ...evidence,
    marketRegime: "QUIET",
    deviationFromMeanBps: -65,
    recoveryBps: 15,
    protocolFlowZScore: 0.5,
    liquidityScore: 0.8,
    spreadBps: 12,
  };

  it("proposes after a depressed price begins recovering with flow support", () => {
    const result = strategy.evaluate({ context, features: qualifying });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ thesisCode: "FLOW_AWARE_MEAN_REVERSION_V1" });
  });

  it("abstains during a falling regime", () => {
    expect(
      strategy.evaluate({ context, features: { ...qualifying, marketRegime: "FALLING" } }),
    ).toEqual([]);
  });
});
