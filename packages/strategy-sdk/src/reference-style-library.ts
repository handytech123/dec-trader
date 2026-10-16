import type { MarketRegime, PaperStyleProfile } from "./style-selector.js";

export type ReferenceStyleId = "LONG_TREND" | "LONG_MEAN_REVERSION";

export interface StyleTrainingObservation {
  readonly sourceTime: string;
  readonly regime: MarketRegime;
  readonly regimeConfidence: number;
  readonly liquidityScore: number;
  readonly spreadBps: number;
  readonly deviationFromMeanBps: number;
  readonly forwardReturnBps: number;
  readonly protocolFlowZScore: number | null;
  readonly capitalFlowEpisodeCount: number;
}

export interface ReferenceStyleDefinition {
  readonly styleId: ReferenceStyleId;
  readonly version: string;
  readonly supportedRegimes: readonly Exclude<MarketRegime, "INSUFFICIENT_DATA">[];
  readonly minimumRegimeConfidence: number;
  readonly minimumLiquidityScore: number;
  readonly maximumSpreadBps: number;
  readonly entryThresholdBps: number;
  readonly flowPolicy: "POSITIVE_PROTOCOL_ACTIVITY" | "ANY_OBSERVED_FLOW";
}

export interface ReferenceStyleWalkForwardResult {
  readonly verdict: "NOT_TESTED" | "WALK_FORWARD_PASS" | "WALK_FORWARD_FAIL";
  readonly foldCount: number;
  readonly evaluableFoldCount: number;
  readonly evaluationTradeCount: number;
  readonly positiveFoldFraction: number | null;
  readonly netExpectancyBps: number | null;
}

export interface TrainedReferenceStyle {
  readonly profile: PaperStyleProfile;
  readonly tradeCount: number;
  readonly winRate: number;
  readonly cumulativeNetReturnBps: number;
  readonly validationVerdict: "NOT_TESTED" | "WALK_FORWARD_PASS" | "WALK_FORWARD_FAIL";
}

export const referenceStyleLibrary: readonly ReferenceStyleDefinition[] = [
  {
    styleId: "LONG_TREND",
    version: "long-trend-v1",
    supportedRegimes: ["RISING"],
    minimumRegimeConfidence: 0.65,
    minimumLiquidityScore: 0.6,
    maximumSpreadBps: 30,
    entryThresholdBps: 20,
    flowPolicy: "POSITIVE_PROTOCOL_ACTIVITY",
  },
  {
    styleId: "LONG_MEAN_REVERSION",
    version: "long-mean-reversion-v1",
    supportedRegimes: ["QUIET", "VOLATILE"],
    minimumRegimeConfidence: 0.6,
    minimumLiquidityScore: 0.7,
    maximumSpreadBps: 20,
    entryThresholdBps: 50,
    flowPolicy: "ANY_OBSERVED_FLOW",
  },
];

const finite = (value: number, label: string): void => {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
};

const qualifies = (
  definition: ReferenceStyleDefinition,
  observation: StyleTrainingObservation,
): boolean => {
  if (observation.regime === "INSUFFICIENT_DATA") return false;
  if (!definition.supportedRegimes.includes(observation.regime)) return false;
  if (observation.regimeConfidence < definition.minimumRegimeConfidence) return false;
  if (observation.liquidityScore < definition.minimumLiquidityScore) return false;
  if (observation.spreadBps > definition.maximumSpreadBps) return false;
  if (
    definition.flowPolicy === "POSITIVE_PROTOCOL_ACTIVITY" &&
    (observation.protocolFlowZScore === null || observation.protocolFlowZScore < 0)
  )
    return false;
  if (
    definition.flowPolicy === "ANY_OBSERVED_FLOW" &&
    observation.protocolFlowZScore === null &&
    observation.capitalFlowEpisodeCount === 0
  )
    return false;
  if (definition.styleId === "LONG_TREND")
    return observation.deviationFromMeanBps >= definition.entryThresholdBps;
  return observation.deviationFromMeanBps <= -definition.entryThresholdBps;
};

/** Evaluates fixed style rules only on chronological future folds. */
export function validateReferenceStyleWalkForward(input: {
  readonly definition: ReferenceStyleDefinition;
  readonly observations: readonly StyleTrainingObservation[];
  readonly roundTripCostBps: number;
  readonly minimumDevelopmentObservations: number;
  readonly evaluationWindowObservations: number;
  readonly minimumEvaluationTrades: number;
  readonly minimumPositiveFoldFraction: number;
}): ReferenceStyleWalkForwardResult {
  finite(input.roundTripCostBps, "round-trip cost");
  finite(input.minimumPositiveFoldFraction, "positive fold fraction");
  if (input.roundTripCostBps < 0) throw new Error("round-trip cost cannot be negative");
  if (
    !Number.isInteger(input.minimumDevelopmentObservations) ||
    input.minimumDevelopmentObservations < 1 ||
    !Number.isInteger(input.evaluationWindowObservations) ||
    input.evaluationWindowObservations < 1 ||
    !Number.isInteger(input.minimumEvaluationTrades) ||
    input.minimumEvaluationTrades < 1
  )
    throw new Error("walk-forward sizes must be positive integers");
  if (input.minimumPositiveFoldFraction < 0 || input.minimumPositiveFoldFraction > 1)
    throw new Error("positive fold fraction must be between zero and one");

  const ordered = [...input.observations].sort((left, right) =>
    left.sourceTime.localeCompare(right.sourceTime),
  );
  const folds: { readonly tradeCount: number; readonly expectancyBps: number | null }[] = [];
  for (
    let start = input.minimumDevelopmentObservations;
    start < ordered.length;
    start += input.evaluationWindowObservations
  ) {
    const netReturns = ordered
      .slice(start, start + input.evaluationWindowObservations)
      .filter((observation) => qualifies(input.definition, observation))
      .map((observation) => observation.forwardReturnBps - input.roundTripCostBps);
    folds.push({
      tradeCount: netReturns.length,
      expectancyBps:
        netReturns.length === 0
          ? null
          : netReturns.reduce((sum, value) => sum + value, 0) / netReturns.length,
    });
  }
  const evaluable = folds.filter((fold) => fold.expectancyBps !== null);
  const evaluationTradeCount = evaluable.reduce((sum, fold) => sum + fold.tradeCount, 0);
  const positiveFoldFraction = evaluable.length
    ? evaluable.filter((fold) => (fold.expectancyBps ?? 0) > 0).length / evaluable.length
    : null;
  const netExpectancyBps = evaluationTradeCount
    ? evaluable.reduce((sum, fold) => sum + (fold.expectancyBps ?? 0) * fold.tradeCount, 0) /
      evaluationTradeCount
    : null;
  const testable = folds.length > 0 && evaluable.length > 0;
  return {
    verdict: !testable
      ? "NOT_TESTED"
      : evaluationTradeCount >= input.minimumEvaluationTrades &&
          (positiveFoldFraction ?? 0) >= input.minimumPositiveFoldFraction &&
          (netExpectancyBps ?? 0) > 0
        ? "WALK_FORWARD_PASS"
        : "WALK_FORWARD_FAIL",
    foldCount: folds.length,
    evaluableFoldCount: evaluable.length,
    evaluationTradeCount,
    positiveFoldFraction,
    netExpectancyBps,
  };
}

/**
 * Fits a transparent reference style to chronological, already labeled observations. Approval is
 * never inferred from this sample: only a separate walk-forward verdict can enable paper routing.
 */
export function trainReferenceStyle(input: {
  readonly definition: ReferenceStyleDefinition;
  readonly observations: readonly StyleTrainingObservation[];
  readonly roundTripCostBps: number;
  readonly minimumSampleSize: number;
  readonly validationVerdict: TrainedReferenceStyle["validationVerdict"];
}): TrainedReferenceStyle {
  finite(input.roundTripCostBps, "round-trip cost");
  if (input.roundTripCostBps < 0) throw new Error("round-trip cost cannot be negative");
  if (!Number.isInteger(input.minimumSampleSize) || input.minimumSampleSize < 1)
    throw new Error("minimum sample size must be positive");
  const ordered = [...input.observations].sort((left, right) =>
    left.sourceTime.localeCompare(right.sourceTime),
  );
  for (const observation of ordered) {
    if (!Number.isFinite(new Date(observation.sourceTime).getTime()))
      throw new Error("invalid style observation time");
    for (const [label, value] of [
      ["regime confidence", observation.regimeConfidence],
      ["liquidity score", observation.liquidityScore],
      ["spread", observation.spreadBps],
      ["mean deviation", observation.deviationFromMeanBps],
      ["forward return", observation.forwardReturnBps],
      ["capital-flow episode count", observation.capitalFlowEpisodeCount],
    ] as const)
      finite(value, label);
    if (observation.protocolFlowZScore !== null)
      finite(observation.protocolFlowZScore, "protocol-flow z-score");
    if (
      !Number.isInteger(observation.capitalFlowEpisodeCount) ||
      observation.capitalFlowEpisodeCount < 0
    )
      throw new Error("capital-flow episode count must be a non-negative integer");
  }
  const trades = ordered.filter((observation) => qualifies(input.definition, observation));
  const netReturns = trades.map(
    (observation) => observation.forwardReturnBps - input.roundTripCostBps,
  );
  const cumulativeNetReturnBps = netReturns.reduce((sum, value) => sum + value, 0);
  const grossExpectancyBps = trades.length
    ? trades.reduce((sum, observation) => sum + observation.forwardReturnBps, 0) / trades.length
    : 0;
  let equity = 0;
  let peak = 0;
  let maximumDrawdownBps = 0;
  for (const netReturn of netReturns) {
    equity += netReturn;
    peak = Math.max(peak, equity);
    maximumDrawdownBps = Math.max(maximumDrawdownBps, peak - equity);
  }
  const walkForwardPassed = input.validationVerdict === "WALK_FORWARD_PASS";
  const hasSufficientPositiveSample =
    trades.length >= input.minimumSampleSize && grossExpectancyBps - input.roundTripCostBps > 0;
  return {
    profile: {
      styleId: input.definition.styleId,
      version: input.definition.version,
      status:
        walkForwardPassed && hasSufficientPositiveSample
          ? "APPROVED_FOR_PAPER"
          : input.validationVerdict === "WALK_FORWARD_FAIL"
            ? "REJECTED"
            : "RESEARCH_ONLY",
      supportedRegimes: input.definition.supportedRegimes,
      sampleSize: trades.length,
      minimumSampleSize: input.minimumSampleSize,
      grossExpectancyBps,
      expectedCostBps: input.roundTripCostBps,
      maximumDrawdownBps,
      minimumRegimeConfidence: input.definition.minimumRegimeConfidence,
      minimumLiquidityScore: input.definition.minimumLiquidityScore,
      maximumSpreadBps: input.definition.maximumSpreadBps,
    },
    tradeCount: trades.length,
    winRate: trades.length ? netReturns.filter((value) => value > 0).length / trades.length : 0,
    cumulativeNetReturnBps,
    validationVerdict: input.validationVerdict,
  };
}
