import type { ReadonlyFeatureSnapshot } from "@autonomous-trading-lab/strategy-sdk";

export interface CfieResearchSourceSnapshot {
  readonly observedAt: string;
  readonly referencePriceUsd: number;
  readonly referencePrice5mAgoUsd: number | null;
  readonly referenceMean1hUsd: number | null;
  readonly referenceConfidence: number;
  readonly uncertaintyBps: number | null;
  readonly marketRegime: string | null;
  readonly realizedVolatilityPct: number | null;
  readonly protocolFlowZScore: number | null;
  readonly flowEventCount: number | null;
  readonly spreadBps: number | null;
  readonly orderBookImbalance: number | null;
  readonly depthChangePct: number | null;
  readonly reactionReturnPct: number | null;
  readonly evidenceClassification: string | null;
  readonly evidenceSampleSize: number;
  readonly expectedNetBps: number | null;
  readonly replayReproducibility: number | null;
}

const finiteOrNull = (value: number | null): number | null =>
  value !== null && Number.isFinite(value) ? value : null;

const returnBps = (current: number, prior: number | null): number | null =>
  prior === null || !Number.isFinite(prior) || prior <= 0
    ? null
    : ((current - prior) / prior) * 10_000;

/**
 * Converts only observations available at observedAt into a closed, strategy-facing snapshot.
 * Missing upstream evidence remains null so every strategy fails closed instead of inferring it.
 */
export function buildCfieResearchFeatures(
  source: CfieResearchSourceSnapshot,
): ReadonlyFeatureSnapshot {
  if (!Number.isFinite(Date.parse(source.observedAt))) throw new Error("invalid observation time");
  if (!Number.isFinite(source.referencePriceUsd) || source.referencePriceUsd <= 0)
    throw new Error("reference price must be positive");
  if (
    !Number.isFinite(source.referenceConfidence) ||
    source.referenceConfidence < 0 ||
    source.referenceConfidence > 1
  )
    throw new Error("reference confidence must be between zero and one");
  if (!Number.isInteger(source.evidenceSampleSize) || source.evidenceSampleSize < 0)
    throw new Error("evidence sample size must be non-negative");

  const return5mBps = returnBps(source.referencePriceUsd, source.referencePrice5mAgoUsd);
  const deviationFromMeanBps = returnBps(source.referencePriceUsd, source.referenceMean1hUsd);
  const reactionReturnBps =
    source.reactionReturnPct === null ? null : source.reactionReturnPct * 100;
  const depthRetentionScore =
    source.depthChangePct === null
      ? null
      : Math.max(0, Math.min(1, 1 + source.depthChangePct / 100));
  const observedValues = [
    return5mBps,
    deviationFromMeanBps,
    source.protocolFlowZScore,
    source.spreadBps,
    source.orderBookImbalance,
    depthRetentionScore,
    reactionReturnBps,
  ].filter((value) => value !== null).length;

  return {
    referencePriceUsd: source.referencePriceUsd,
    referenceConfidence: source.referenceConfidence,
    uncertaintyBps: finiteOrNull(source.uncertaintyBps),
    marketRegime: source.marketRegime ?? "INSUFFICIENT_DATA",
    realizedVolatilityPct: finiteOrNull(source.realizedVolatilityPct),
    return5mBps,
    deviationFromMeanBps,
    protocolFlowZScore: finiteOrNull(source.protocolFlowZScore),
    flowMagnitudeZScore:
      source.protocolFlowZScore === null ? null : Math.abs(source.protocolFlowZScore),
    flowEventCount: source.flowEventCount,
    spreadBps: finiteOrNull(source.spreadBps),
    orderBookImbalance: finiteOrNull(source.orderBookImbalance),
    depthRetentionScore,
    recoveryBps: reactionReturnBps,
    confirmationReturnBps: reactionReturnBps,
    evidenceVerdict: source.evidenceClassification ?? "INSUFFICIENT_DATA",
    evidenceSampleSize: source.evidenceSampleSize,
    expectedNetBps: finiteOrNull(source.expectedNetBps),
    replayReproducibility: finiteOrNull(source.replayReproducibility),
    featureCoverage: observedValues / 7,
    availableFeatureCount: observedValues,
    requiredFeatureCount: 7,
  };
}
