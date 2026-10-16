import { createHash } from "node:crypto";
import { contentHash } from "@autonomous-trading-lab/domain";

export interface BaselineCandidate {
  readonly observationId: string;
  readonly assetId: string;
  readonly observedAt: string;
  readonly regime: string;
  readonly value: number;
}

const score = (seed: string, value: string): string =>
  createHash("sha256").update(`${seed}:${value}`).digest("hex");

const stratum = (candidate: BaselineCandidate): string => {
  const date = new Date(candidate.observedAt);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid baseline timestamp");
  return JSON.stringify([
    candidate.assetId,
    date.toISOString().slice(0, 10),
    date.getUTCHours(),
    candidate.regime,
  ]);
};

export function constrainedRandomBaseline(input: {
  readonly selected: readonly BaselineCandidate[];
  readonly candidates: readonly BaselineCandidate[];
  readonly seed: string;
}) {
  const selectedIds = new Set(input.selected.map((candidate) => candidate.observationId));
  const pools = new Map<string, BaselineCandidate[]>();
  for (const candidate of input.candidates) {
    if (selectedIds.has(candidate.observationId)) continue;
    const key = stratum(candidate);
    const values = pools.get(key) ?? [];
    values.push(candidate);
    pools.set(key, values);
  }
  for (const values of pools.values())
    values.sort(
      (left, right) =>
        score(input.seed, left.observationId).localeCompare(
          score(input.seed, right.observationId),
        ) || left.observationId.localeCompare(right.observationId),
    );
  const offsets = new Map<string, number>();
  const matches = input.selected.map((candidate) => {
    const key = stratum(candidate);
    const pool = pools.get(key) ?? [];
    const offset = offsets.get(key) ?? 0;
    const match = pool.at(offset) ?? null;
    offsets.set(key, offset + 1);
    return { selectedObservationId: candidate.observationId, baseline: match, stratum: key };
  });
  return {
    method: "CONSTRAINED_RANDOM_BASELINE_V1" as const,
    seed: input.seed,
    selectedCount: input.selected.length,
    matchedCount: matches.filter((match) => match.baseline !== null).length,
    unmatchedCount: matches.filter((match) => match.baseline === null).length,
    matches,
    configurationHash: contentHash({
      method: "CONSTRAINED_RANDOM_BASELINE_V1",
      seed: input.seed,
      strata: ["asset", "utc_date", "utc_hour", "regime"],
    }),
  };
}

export function extremeObservationSensitivity(
  observations: readonly {
    readonly observationId: string;
    readonly magnitude: number;
    readonly value: number;
  }[],
  removalCounts: readonly number[] = [1, 3, 5],
) {
  if (observations.some((item) => !Number.isFinite(item.magnitude) || !Number.isFinite(item.value)))
    throw new Error("sensitivity values must be finite");
  const ordered = [...observations].sort(
    (left, right) =>
      Math.abs(right.magnitude) - Math.abs(left.magnitude) ||
      left.observationId.localeCompare(right.observationId),
  );
  const mean = (values: readonly (typeof observations)[number][]): number | null =>
    values.length === 0
      ? null
      : values.reduce((sum, observation) => sum + observation.value, 0) / values.length;
  return {
    fullSampleMean: mean(ordered),
    results: [...new Set(removalCounts)]
      .sort((left, right) => left - right)
      .map((removeCount) => {
        if (!Number.isInteger(removeCount) || removeCount < 0)
          throw new Error("removal counts must be non-negative integers");
        const retained = ordered.slice(removeCount);
        return {
          removeLargestCount: removeCount,
          retainedCount: retained.length,
          mean: mean(retained),
          removedObservationIds: ordered.slice(0, removeCount).map((item) => item.observationId),
        };
      }),
  };
}

export function shiftedTimestampPlacebo<T extends { readonly observedAt: string }>(
  observations: readonly T[],
  shiftSeconds: number,
): readonly (T & { readonly placeboObservedAt: string })[] {
  if (!Number.isInteger(shiftSeconds) || shiftSeconds === 0)
    throw new Error("placebo timestamp shift must be a non-zero integer");
  return observations.map((observation) => {
    const timestamp = new Date(observation.observedAt).getTime();
    if (!Number.isFinite(timestamp)) throw new Error("invalid placebo timestamp");
    return {
      ...observation,
      placeboObservedAt: new Date(timestamp + shiftSeconds * 1000).toISOString(),
    };
  });
}
