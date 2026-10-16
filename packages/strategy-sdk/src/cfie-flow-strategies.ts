import { deterministicDomainId, type TradeProposal } from "@autonomous-trading-lab/domain";
import type { StrategyInput, StrategyModule } from "./index.js";

export interface EvidenceGatedStrategyConfig {
  readonly strategyVersionId: string;
  readonly experimentId: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly requestedInputAtomic: string;
  readonly minimumExpectedNetBps: number;
  readonly minimumEvidenceSampleSize: number;
  readonly minimumReplayReproducibility: number;
  readonly proposalLifetimeSeconds: number;
}

export interface FlowConfirmedMomentumConfig extends EvidenceGatedStrategyConfig {
  readonly minimumReturn5mBps: number;
  readonly minimumVolumeAcceleration: number;
  readonly minimumLiquidityScore: number;
  readonly maximumSpreadBps: number;
  readonly minimumProtocolFlowZScore: number;
}

export interface PostFlowContinuationConfig extends EvidenceGatedStrategyConfig {
  readonly minimumFlowMagnitudeZScore: number;
  readonly minimumConfirmationReturnBps: number;
  readonly minimumVolumeAcceleration: number;
  readonly minimumOrderBookImbalance: number;
  readonly minimumLiquidityScore: number;
  readonly maximumSpreadBps: number;
}

export interface PostFlowReversalConfig extends EvidenceGatedStrategyConfig {
  readonly minimumFlowMagnitudeZScore: number;
  readonly maximumShockReturnBps: number;
  readonly minimumRecoveryReturnBps: number;
  readonly minimumOrderBookImbalance: number;
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

/** Long-only momentum candidate requiring price, volume, liquidity, and protocol-flow agreement. */
export function createFlowConfirmedMomentumStrategy(
  config: FlowConfirmedMomentumConfig,
): StrategyModule {
  validateBase(config);
  validateNonNegative(config.minimumVolumeAcceleration, "minimum volume acceleration");
  validateUnitInterval(config.minimumLiquidityScore, "minimum liquidity score");
  validateNonNegative(config.maximumSpreadBps, "maximum spread bps");
  return {
    evaluate: (input): readonly TradeProposal[] => {
      const return5mBps = numeric(input.features.return5mBps);
      const volumeAcceleration = numeric(input.features.volumeAcceleration);
      const liquidityScore = numeric(input.features.liquidityScore);
      const spreadBps = numeric(input.features.spreadBps);
      const protocolFlowZScore = numeric(input.features.protocolFlowZScore);
      if (
        !evidencePasses(input.features, config) ||
        input.features.marketRegime !== "RISING" ||
        return5mBps === null ||
        return5mBps < config.minimumReturn5mBps ||
        volumeAcceleration === null ||
        volumeAcceleration < config.minimumVolumeAcceleration ||
        liquidityScore === null ||
        liquidityScore < config.minimumLiquidityScore ||
        spreadBps === null ||
        spreadBps > config.maximumSpreadBps ||
        protocolFlowZScore === null ||
        protocolFlowZScore < config.minimumProtocolFlowZScore
      )
        return [];
      return [
        proposal(input, config, "FLOW_CONFIRMED_MOMENTUM_V1", {
          marketRegime: "RISING",
          return5mBps,
          volumeAcceleration,
          liquidityScore,
          spreadBps,
          protocolFlowZScore,
        }),
      ];
    },
  };
}

/** Long-only continuation candidate following a large inflow with market confirmation. */
export function createPostFlowContinuationStrategy(
  config: PostFlowContinuationConfig,
): StrategyModule {
  validateBase(config);
  validateNonNegative(config.minimumFlowMagnitudeZScore, "minimum flow magnitude z-score");
  validateNonNegative(config.minimumVolumeAcceleration, "minimum volume acceleration");
  validateUnitInterval(config.minimumLiquidityScore, "minimum liquidity score");
  validateNonNegative(config.maximumSpreadBps, "maximum spread bps");
  return {
    evaluate: (input): readonly TradeProposal[] => {
      const flowMagnitudeZScore = numeric(input.features.flowMagnitudeZScore);
      const confirmationReturnBps = numeric(input.features.confirmationReturnBps);
      const volumeAcceleration = numeric(input.features.volumeAcceleration);
      const orderBookImbalance = numeric(input.features.orderBookImbalance);
      const liquidityScore = numeric(input.features.liquidityScore);
      const spreadBps = numeric(input.features.spreadBps);
      if (
        !evidencePasses(input.features, config) ||
        input.features.flowDirection !== "INFLOW" ||
        flowMagnitudeZScore === null ||
        flowMagnitudeZScore < config.minimumFlowMagnitudeZScore ||
        confirmationReturnBps === null ||
        confirmationReturnBps < config.minimumConfirmationReturnBps ||
        volumeAcceleration === null ||
        volumeAcceleration < config.minimumVolumeAcceleration ||
        orderBookImbalance === null ||
        orderBookImbalance < config.minimumOrderBookImbalance ||
        liquidityScore === null ||
        liquidityScore < config.minimumLiquidityScore ||
        spreadBps === null ||
        spreadBps > config.maximumSpreadBps
      )
        return [];
      return [
        proposal(input, config, "POST_FLOW_CONTINUATION_V1", {
          flowDirection: "INFLOW",
          flowMagnitudeZScore,
          confirmationReturnBps,
          volumeAcceleration,
          orderBookImbalance,
          liquidityScore,
          spreadBps,
        }),
      ];
    },
  };
}

/** Long-only reversal candidate after a large outflow shock begins to recover with buy support. */
export function createPostFlowReversalStrategy(config: PostFlowReversalConfig): StrategyModule {
  validateBase(config);
  validateNonNegative(config.minimumFlowMagnitudeZScore, "minimum flow magnitude z-score");
  validateUnitInterval(config.minimumLiquidityScore, "minimum liquidity score");
  validateNonNegative(config.maximumSpreadBps, "maximum spread bps");
  return {
    evaluate: (input): readonly TradeProposal[] => {
      const flowMagnitudeZScore = numeric(input.features.flowMagnitudeZScore);
      const shockReturnBps = numeric(input.features.shockReturnBps);
      const recoveryReturnBps = numeric(input.features.recoveryReturnBps);
      const orderBookImbalance = numeric(input.features.orderBookImbalance);
      const liquidityScore = numeric(input.features.liquidityScore);
      const spreadBps = numeric(input.features.spreadBps);
      if (
        !evidencePasses(input.features, config) ||
        input.features.flowDirection !== "OUTFLOW" ||
        flowMagnitudeZScore === null ||
        flowMagnitudeZScore < config.minimumFlowMagnitudeZScore ||
        shockReturnBps === null ||
        shockReturnBps > config.maximumShockReturnBps ||
        recoveryReturnBps === null ||
        recoveryReturnBps < config.minimumRecoveryReturnBps ||
        orderBookImbalance === null ||
        orderBookImbalance < config.minimumOrderBookImbalance ||
        liquidityScore === null ||
        liquidityScore < config.minimumLiquidityScore ||
        spreadBps === null ||
        spreadBps > config.maximumSpreadBps
      )
        return [];
      return [
        proposal(input, config, "POST_FLOW_REVERSAL_V1", {
          flowDirection: "OUTFLOW",
          flowMagnitudeZScore,
          shockReturnBps,
          recoveryReturnBps,
          orderBookImbalance,
          liquidityScore,
          spreadBps,
        }),
      ];
    },
  };
}
