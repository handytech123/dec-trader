import { contentHash } from "@autonomous-trading-lab/domain";
import {
  clusterBootstrapMean,
  overlapDiagnostics,
  selectDeterministicNonOverlapping,
  type DependentObservation,
} from "./dependence.js";

export const PHASE_TWO_HYPOTHESIS_BUDGET = {
  version: 1,
  maximumPerFamily: 12,
  maximumFamilies: 6,
  maximumTotal: 72,
} as const;

export function evaluateHypothesisBudget(attempts: readonly { readonly family: string }[]) {
  const counts = new Map<string, number>();
  for (const attempt of attempts) counts.set(attempt.family, (counts.get(attempt.family) ?? 0) + 1);
  const familyCounts = Object.fromEntries(
    [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  const violations = [
    ...(attempts.length > PHASE_TWO_HYPOTHESIS_BUDGET.maximumTotal
      ? ["TOTAL_BUDGET_EXCEEDED"]
      : []),
    ...(counts.size > PHASE_TWO_HYPOTHESIS_BUDGET.maximumFamilies
      ? ["FAMILY_BUDGET_EXCEEDED"]
      : []),
    ...[...counts.entries()]
      .filter(([, count]) => count > PHASE_TWO_HYPOTHESIS_BUDGET.maximumPerFamily)
      .map(([family]) => `FAMILY_ATTEMPT_BUDGET_EXCEEDED:${family}`),
  ];
  return {
    policyHash: contentHash(PHASE_TWO_HYPOTHESIS_BUDGET),
    totalAttempts: attempts.length,
    familyCounts,
    eligible: violations.length === 0,
    violations,
  } as const;
}

const systematicSample = (
  observations: readonly DependentObservation[],
  maximum: number,
): readonly DependentObservation[] =>
  observations.length <= maximum
    ? observations
    : Array.from({ length: maximum }, (_, index) => {
        const selected = observations.at(Math.floor((index * observations.length) / maximum));
        if (!selected) throw new Error("systematic sample index is invalid");
        return selected;
      });

export function compareEpisodeInference(
  observations: readonly DependentObservation[],
  seed: number,
) {
  if (observations.length === 0) throw new Error("inference comparison requires observations");
  const ordered = [...observations].sort(
    (left, right) =>
      left.eventTime.localeCompare(right.eventTime) ||
      left.observationId.localeCompare(right.observationId),
  );
  const episodeGroups = new Map<string, DependentObservation[]>();
  for (const observation of ordered) {
    const key = `${observation.episodeId}:${String(observation.horizonSeconds)}`;
    episodeGroups.set(key, [...(episodeGroups.get(key) ?? []), observation]);
  }
  const fullEpisode = [...episodeGroups.entries()].map(([key, items]) => {
    const first = items[0];
    if (!first) throw new Error("episode group is empty");
    const regimes = new Set(items.map((item) => item.regime));
    return {
      observationId: `aggregate:${key}`,
      episodeId: first.episodeId,
      eventTime: items.map((item) => item.eventTime).sort()[0] ?? first.eventTime,
      horizonSeconds: first.horizonSeconds,
      value: items.reduce((sum, item) => sum + item.value, 0) / items.length,
      ...(regimes.size === 1 && first.regime !== undefined ? { regime: first.regime } : {}),
    };
  });
  const samples = [
    { method: "DETERMINISTIC_5000", values: systematicSample(ordered, 5000) },
    { method: "DETERMINISTIC_20000", values: systematicSample(ordered, 20_000) },
    { method: "FULL_EPISODE", values: fullEpisode },
  ] as const;
  return {
    rawObservationCount: ordered.length,
    episodeCount: new Set(ordered.map((item) => item.episodeId)).size,
    episodeHorizonRepresentationCount: fullEpisode.length,
    utcDayCount: new Set(ordered.map((item) => item.eventTime.slice(0, 10))).size,
    overlap: overlapDiagnostics(ordered),
    nonOverlappingCount: selectDeterministicNonOverlapping(ordered).length,
    methods: samples.map(({ method, values }, index) => ({
      method,
      observationCount: values.length,
      mean: values.map((item) => item.value).reduce((sum, value) => sum + value, 0) / values.length,
      episodeBootstrap: clusterBootstrapMean(values, {
        clusterDefinition: "EPISODE",
        seed: seed + index,
        iterations: 499,
      }),
      dayBootstrap: clusterBootstrapMean(values, {
        clusterDefinition: "UTC_DAY",
        seed: seed + 100 + index,
        iterations: 499,
      }),
      regimeBootstrap: values.every((item) => item.regime !== undefined)
        ? clusterBootstrapMean(values, {
            clusterDefinition: "MARKET_REGIME",
            seed: seed + 200 + index,
            iterations: 499,
          })
        : null,
    })),
  } as const;
}

export type FragilityClassification =
  | "ROBUST"
  | "MODERATELY_FRAGILE"
  | "HIGHLY_FRAGILE"
  | "REJECTED";

export function classifyCandidateFragility(input: {
  readonly significant: boolean;
  readonly economicallyMaterial: boolean;
  readonly intervalExcludesZero: boolean;
  readonly survivesLargestEventRemoval: boolean;
  readonly survivesNonOverlap: boolean;
  readonly walkForwardStable: boolean;
}): { readonly classification: FragilityClassification; readonly reasons: readonly string[] } {
  const reasons = Object.entries(input)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (!input.significant || !input.economicallyMaterial)
    return { classification: "REJECTED", reasons };
  if (!input.intervalExcludesZero || !input.walkForwardStable)
    return { classification: "HIGHLY_FRAGILE", reasons };
  if (!input.survivesLargestEventRemoval || !input.survivesNonOverlap)
    return { classification: "MODERATELY_FRAGILE", reasons };
  return { classification: "ROBUST", reasons: [] };
}
