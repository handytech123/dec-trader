import { contentHash } from "@autonomous-trading-lab/domain";

const quantile = (sorted: readonly number[], probability: number): number => {
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const fraction = index - lower;
  const lowerValue = sorted.at(lower);
  if (lowerValue === undefined) throw new Error("quantile index is invalid");
  return lowerValue + ((sorted.at(lower + 1) ?? lowerValue) - lowerValue) * fraction;
};

export interface ReturnEffectSummary {
  readonly count: number;
  readonly mean: number;
  readonly median: number;
  readonly standardDeviation: number;
  readonly quantiles: Readonly<Record<"p05" | "p25" | "p75" | "p95", number>>;
  readonly positiveFraction: number;
  readonly baselineMean: number;
  readonly differenceVersusBaseline: number;
  readonly standardizedEffect: number | null;
  readonly maximumFavorableExcursion?: number;
  readonly maximumAdverseExcursion?: number;
}

export function summarizeReturnEffect(
  returns: readonly number[],
  baselines: readonly number[],
  excursions?: { readonly favorable: readonly number[]; readonly adverse: readonly number[] },
): ReturnEffectSummary {
  if (returns.length === 0 || returns.length !== baselines.length)
    throw new Error("returns and baselines must have the same non-zero length");
  if (
    returns.some((value) => !Number.isFinite(value)) ||
    baselines.some((value) => !Number.isFinite(value))
  )
    throw new Error("effect values must be finite");
  if (
    excursions &&
    (excursions.favorable.length !== returns.length || excursions.adverse.length !== returns.length)
  )
    throw new Error("excursion arrays must match returns");
  const sorted = [...returns].sort((left, right) => left - right);
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.length < 2
      ? 0
      : returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const standardDeviation = Math.sqrt(variance);
  const baselineMean = baselines.reduce((sum, value) => sum + value, 0) / baselines.length;
  return {
    count: returns.length,
    mean,
    median: quantile(sorted, 0.5),
    standardDeviation,
    quantiles: {
      p05: quantile(sorted, 0.05),
      p25: quantile(sorted, 0.25),
      p75: quantile(sorted, 0.75),
      p95: quantile(sorted, 0.95),
    },
    positiveFraction: returns.filter((value) => value > 0).length / returns.length,
    baselineMean,
    differenceVersusBaseline: mean - baselineMean,
    standardizedEffect: standardDeviation === 0 ? null : (mean - baselineMean) / standardDeviation,
    ...(excursions
      ? {
          maximumFavorableExcursion: Math.max(...excursions.favorable),
          maximumAdverseExcursion: Math.min(...excursions.adverse),
        }
      : {}),
  };
}

export interface MaterialityPolicy {
  readonly version: number;
  readonly featureFamily: string;
  readonly horizonSeconds: number;
  readonly minimumAbsoluteEffect: number;
  readonly hypotheticalSpread: number;
  readonly hypotheticalFee: number;
  readonly hypotheticalSlippage: number;
  readonly hypotheticalLatencyCost: number;
}

export function evaluateEconomicMateriality(effect: number, policy: MaterialityPolicy) {
  if (policy.version < 1 || policy.horizonSeconds < 1 || policy.minimumAbsoluteEffect < 0)
    throw new Error("invalid materiality policy");
  const totalFriction =
    policy.hypotheticalSpread +
    policy.hypotheticalFee +
    policy.hypotheticalSlippage +
    policy.hypotheticalLatencyCost;
  const netEffect = Math.sign(effect) * Math.max(0, Math.abs(effect) - totalFriction);
  const materiallyStrong = Math.abs(netEffect) >= policy.minimumAbsoluteEffect;
  return {
    policyHash: contentHash(policy),
    grossEffect: effect,
    totalFriction,
    netEffect,
    decision: materiallyStrong
      ? ("ECONOMICALLY_MATERIAL" as const)
      : ("ECONOMICALLY_WEAK" as const),
  };
}
