import { deterministicDomainId, type TradeProposal } from "@autonomous-trading-lab/domain";
import type { EvidenceGatedStrategyConfig } from "./cfie-flow-strategies.js";
import type { StrategyInput, StrategyModule } from "./index.js";

export interface LiquidityConfirmedBreakoutConfig extends EvidenceGatedStrategyConfig {
  readonly minimumBreakoutBps: number;
  readonly minimumVolumeAcceleration: number;
  readonly minimumDepthRetentionScore: number;
  readonly minimumVenueConfirmations: number;
  readonly minimumLiquidityScore: number;
  readonly maximumSpreadBps: number;
}

export interface CrossVenueDislocationConfig extends EvidenceGatedStrategyConfig {
  readonly minimumDexDiscountBps: number;
  readonly minimumExecutableEdgeBps: number;
  readonly minimumReferenceConfidence: number;
  readonly maximumQuoteAgeMs: number;
  readonly maximumEstimatedCostBps: number;
}

export interface FlowAwareMeanReversionConfig extends EvidenceGatedStrategyConfig {
  readonly minimumNegativeDeviationBps: number;
  readonly minimumRecoveryBps: number;
  readonly minimumProtocolFlowZScore: number;
  readonly minimumLiquidityScore: number;
  readonly maximumSpreadBps: number;
}

const numeric = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function validateBase(config: EvidenceGatedStrategyConfig): void {
  if (!Number.isInteger(config.minimumEvidenceSampleSize) || config.minimumEvidenceSampleSize < 1)
    throw new Error("minimum evidence sample size must be positive");
  if (!Number.isFinite(config.minimumExpectedNetBps))
    throw new Error("minimum expected net bps must be finite");
  if (
    !Number.isFinite(config.minimumReplayReproducibility) ||
    config.minimumReplayReproducibility < 0 ||
    config.minimumReplayReproducibility > 1
  )
    throw new Error("minimum replay reproducibility must be between zero and one");
  if (!Number.isInteger(config.proposalLifetimeSeconds) || config.proposalLifetimeSeconds < 1)
    throw new Error("proposal lifetime must be positive");
}

function validateUnitInterval(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error(`${label} must be between zero and one`);
}

function validateNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative`);
}

function evidencePasses(
  features: StrategyInput["features"],
  config: EvidenceGatedStrategyConfig,
): boolean {
  const sampleSize = numeric(features.evidenceSampleSize);
  const expectedNetBps = numeric(features.expectedNetBps);
  const replayReproducibility = numeric(features.replayReproducibility);
  return (
    features.evidenceVerdict === "SUPPORTED" &&
    sampleSize !== null &&
    sampleSize >= config.minimumEvidenceSampleSize &&
    expectedNetBps !== null &&
    expectedNetBps >= config.minimumExpectedNetBps &&
    replayReproducibility !== null &&
    replayReproducibility >= config.minimumReplayReproducibility
  );
}

function proposal(
  input: StrategyInput,
  config: EvidenceGatedStrategyConfig,
  thesisCode: string,
  signalValues: TradeProposal["signalValues"],
): TradeProposal {
  return {
    proposalId: deterministicDomainId(
      "proposal",
      `${input.context.evaluationId}:${config.strategyVersionId}`,
    ),
    strategyVersionId: config.strategyVersionId,
    experimentId: config.experimentId,
    side: "BUY",
    inputMint: config.inputMint,
    outputMint: config.outputMint,
    requestedInputAtomic: config.requestedInputAtomic,
    thesisCode,
    signalValues,
    validUntil: new Date(
      Date.parse(input.context.evaluatedAt) + config.proposalLifetimeSeconds * 1000,
    ).toISOString(),
  };
}

/** Breakout candidate that rejects thin, single-venue, or rapidly disappearing liquidity. */
export function createLiquidityConfirmedBreakoutStrategy(
  config: LiquidityConfirmedBreakoutConfig,
): StrategyModule {
  validateBase(config);
  validateNonNegative(config.minimumBreakoutBps, "minimum breakout bps");
  validateNonNegative(config.minimumVolumeAcceleration, "minimum volume acceleration");
  validateUnitInterval(config.minimumDepthRetentionScore, "minimum depth retention score");
  validateUnitInterval(config.minimumLiquidityScore, "minimum liquidity score");
  validateNonNegative(config.maximumSpreadBps, "maximum spread bps");
  if (!Number.isInteger(config.minimumVenueConfirmations) || config.minimumVenueConfirmations < 1)
    throw new Error("minimum venue confirmations must be positive");
  return {
    evaluate: (input): readonly TradeProposal[] => {
      const breakoutBps = numeric(input.features.breakoutBps);
      const volumeAcceleration = numeric(input.features.volumeAcceleration);
      const depthRetentionScore = numeric(input.features.depthRetentionScore);
      const venueConfirmations = numeric(input.features.venueConfirmations);
      const liquidityScore = numeric(input.features.liquidityScore);
      const spreadBps = numeric(input.features.spreadBps);
      if (
        !evidencePasses(input.features, config) ||
        (input.features.marketRegime !== "RISING" && input.features.marketRegime !== "VOLATILE") ||
        breakoutBps === null ||
        breakoutBps < config.minimumBreakoutBps ||
        volumeAcceleration === null ||
        volumeAcceleration < config.minimumVolumeAcceleration ||
        depthRetentionScore === null ||
        depthRetentionScore < config.minimumDepthRetentionScore ||
        venueConfirmations === null ||
        !Number.isInteger(venueConfirmations) ||
        venueConfirmations < config.minimumVenueConfirmations ||
        liquidityScore === null ||
        liquidityScore < config.minimumLiquidityScore ||
        spreadBps === null ||
        spreadBps > config.maximumSpreadBps
      )
        return [];
      return [
        proposal(input, config, "LIQUIDITY_CONFIRMED_BREAKOUT_V1", {
          marketRegime: input.features.marketRegime,
          breakoutBps,
          volumeAcceleration,
          depthRetentionScore,
          venueConfirmations,
          liquidityScore,
          spreadBps,
        }),
      ];
    },
  };
}

/** Buys only when an executable DEX quote is discounted to a fresh multi-venue reference. */
export function createCrossVenueDislocationStrategy(
  config: CrossVenueDislocationConfig,
): StrategyModule {
  validateBase(config);
  validateNonNegative(config.minimumDexDiscountBps, "minimum DEX discount bps");
  validateNonNegative(config.minimumExecutableEdgeBps, "minimum executable edge bps");
  validateUnitInterval(config.minimumReferenceConfidence, "minimum reference confidence");
  validateNonNegative(config.maximumEstimatedCostBps, "maximum estimated cost bps");
  if (!Number.isInteger(config.maximumQuoteAgeMs) || config.maximumQuoteAgeMs < 1)
    throw new Error("maximum quote age must be positive");
  return {
    evaluate: (input): readonly TradeProposal[] => {
      const dexDiscountBps = numeric(input.features.dexDiscountBps);
      const executableEdgeBps = numeric(input.features.executableEdgeBps);
      const referenceConfidence = numeric(input.features.referenceConfidence);
      const quoteAgeMs = numeric(input.features.quoteAgeMs);
      const estimatedTotalCostBps = numeric(input.features.estimatedTotalCostBps);
      if (
        !evidencePasses(input.features, config) ||
        input.features.referenceVenueCount !== 2 ||
        dexDiscountBps === null ||
        dexDiscountBps < config.minimumDexDiscountBps ||
        executableEdgeBps === null ||
        executableEdgeBps < config.minimumExecutableEdgeBps ||
        referenceConfidence === null ||
        referenceConfidence < config.minimumReferenceConfidence ||
        quoteAgeMs === null ||
        !Number.isInteger(quoteAgeMs) ||
        quoteAgeMs < 0 ||
        quoteAgeMs > config.maximumQuoteAgeMs ||
        estimatedTotalCostBps === null ||
        estimatedTotalCostBps > config.maximumEstimatedCostBps
      )
        return [];
      return [
        proposal(input, config, "CROSS_VENUE_DISLOCATION_V1", {
          referenceVenueCount: 2,
          dexDiscountBps,
          executableEdgeBps,
          referenceConfidence,
          quoteAgeMs,
          estimatedTotalCostBps,
        }),
      ];
    },
  };
}

/** Mean-reversion candidate requiring recovery and non-negative protocol-flow support. */
export function createFlowAwareMeanReversionStrategy(
  config: FlowAwareMeanReversionConfig,
): StrategyModule {
  validateBase(config);
  validateNonNegative(config.minimumNegativeDeviationBps, "minimum negative deviation bps");
  validateNonNegative(config.minimumRecoveryBps, "minimum recovery bps");
  validateUnitInterval(config.minimumLiquidityScore, "minimum liquidity score");
  validateNonNegative(config.maximumSpreadBps, "maximum spread bps");
  return {
    evaluate: (input): readonly TradeProposal[] => {
      const deviationFromMeanBps = numeric(input.features.deviationFromMeanBps);
      const recoveryBps = numeric(input.features.recoveryBps);
      const protocolFlowZScore = numeric(input.features.protocolFlowZScore);
      const liquidityScore = numeric(input.features.liquidityScore);
      const spreadBps = numeric(input.features.spreadBps);
      if (
        !evidencePasses(input.features, config) ||
        (input.features.marketRegime !== "QUIET" && input.features.marketRegime !== "VOLATILE") ||
        deviationFromMeanBps === null ||
        deviationFromMeanBps > -config.minimumNegativeDeviationBps ||
        recoveryBps === null ||
        recoveryBps < config.minimumRecoveryBps ||
        protocolFlowZScore === null ||
        protocolFlowZScore < config.minimumProtocolFlowZScore ||
        liquidityScore === null ||
        liquidityScore < config.minimumLiquidityScore ||
        spreadBps === null ||
        spreadBps > config.maximumSpreadBps
      )
        return [];
      return [
        proposal(input, config, "FLOW_AWARE_MEAN_REVERSION_V1", {
          marketRegime: input.features.marketRegime,
          deviationFromMeanBps,
          recoveryBps,
          protocolFlowZScore,
          liquidityScore,
          spreadBps,
        }),
      ];
    },
  };
}
