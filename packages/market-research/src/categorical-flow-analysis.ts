import { createHash } from "node:crypto";
import { z } from "zod";
import { deterministicPermutationPValue } from "./permutation.js";
import { analyzeCandidateRobustness } from "./robustness.js";

const HorizonSchema = z.enum(["1m", "5m", "15m", "1h", "6h", "24h"]);

export const CategoricalFlowObservationSchema = z
  .object({
    eventId: z.string().min(1),
    eventAt: z.iso.datetime({ offset: true }),
    horizon: HorizonSchema,
    cohort: z.string().min(1).max(250),
    returnPct: z.number(),
    episodeId: z.string().min(1).optional(),
    regime: z.string().min(1).optional(),
  })
  .strict();
export type CategoricalFlowObservation = z.infer<typeof CategoricalFlowObservationSchema>;

export interface CategoricalFlowCell {
  readonly horizon: z.infer<typeof HorizonSchema>;
  readonly cohort: string;
  readonly partition: "DEVELOPMENT" | "HOLDOUT";
  readonly sampleSize: number;
  readonly baselineSize: number;
  readonly meanReturnPct: number | null;
  readonly baselineMeanReturnPct: number | null;
  readonly effectPct: number | null;
  readonly pValue: number | null;
  readonly adjustedPValue: number | null;
  readonly randomizedTimestampPValue: number | null;
  readonly significant: boolean;
  readonly robustness: ReturnType<typeof analyzeCandidateRobustness>;
}

export interface CategoricalFlowAnalysis {
  readonly status: "COMPLETE" | "INSUFFICIENT_DATA";
  readonly observationCount: number;
  readonly minimumSampleSize: number;
  readonly permutationCount: number;
  readonly randomizedTimestampTrials: number;
  readonly holdoutAccessed: boolean;
  readonly cells: readonly CategoricalFlowCell[];
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

function randomizedTimestampAlignmentPValue(
  observations: readonly CategoricalFlowObservation[],
  cohort: string,
  trials: number,
  seed: string,
): number | null {
  const selected = observations.filter((item) => item.cohort === cohort);
  const baseline = observations.filter((item) => item.cohort !== cohort);
  if (selected.length === 0 || baseline.length === 0 || observations.length < 3) return null;
  const observed = Math.abs(
    mean(selected.map((item) => item.returnPct)) - mean(baseline.map((item) => item.returnPct)),
  );
  const labels = observations.map((item) => item.cohort === cohort);
  let extreme = 0;
  for (let trial = 0; trial < trials; trial += 1) {
    const digest = createHash("sha256")
      .update(`${seed}:${String(trial)}`)
      .digest();
    const offset = 1 + (digest.readUInt32BE(0) % (observations.length - 1));
    const shiftedSelected: number[] = [];
    const shiftedBaseline: number[] = [];
    for (let index = 0; index < observations.length; index += 1) {
      const observation = observations.at(index);
      if (!observation) throw new Error("timestamp alignment observation is missing");
      const sourceIndex = (index + offset) % observations.length;
      (labels.at(sourceIndex) === true ? shiftedSelected : shiftedBaseline).push(
        observation.returnPct,
      );
    }
    if (shiftedSelected.length === 0 || shiftedBaseline.length === 0) continue;
    const effect = Math.abs(mean(shiftedSelected) - mean(shiftedBaseline));
    if (effect >= observed) extreme += 1;
  }
  return (extreme + 1) / (trials + 1);
}

export function analyzeCategoricalFlows(input: {
  readonly observations: readonly CategoricalFlowObservation[];
  readonly datasetCutoff: string;
  readonly minimumSampleSize: number;
  readonly holdoutFraction: number;
  readonly falseDiscoveryRate: number;
  readonly permutations?: number;
  readonly seed: string;
  readonly openHoldout?: boolean;
}): CategoricalFlowAnalysis {
  const cutoff = new Date(input.datasetCutoff).getTime();
  if (!Number.isFinite(cutoff)) throw new Error("invalid dataset cutoff");
  if (input.holdoutFraction <= 0 || input.holdoutFraction >= 0.5)
    throw new Error("holdout fraction must be between zero and one half");
  if (!Number.isInteger(input.minimumSampleSize) || input.minimumSampleSize < 2)
    throw new Error("minimum sample size must be at least two");
  const permutations = input.permutations ?? 999;
  if (!Number.isInteger(permutations) || permutations < 99)
    throw new Error("at least 99 permutations are required");
  const parsed = input.observations
    .map((item) => CategoricalFlowObservationSchema.parse(item))
    .filter((item) => new Date(item.eventAt).getTime() <= cutoff);
  const cells: CategoricalFlowCell[] = [];
  const randomizedTimestampTrials = 99;
  for (const horizon of HorizonSchema.options) {
    const observations = parsed
      .filter((item) => item.horizon === horizon)
      .sort(
        (left, right) =>
          left.eventAt.localeCompare(right.eventAt) || left.eventId.localeCompare(right.eventId),
      );
    const holdoutSize = Math.floor(observations.length * input.holdoutFraction);
    const partitions = [
      ["DEVELOPMENT", observations.slice(0, observations.length - holdoutSize)],
      ...(input.openHoldout === true
        ? ([["HOLDOUT", holdoutSize === 0 ? [] : observations.slice(-holdoutSize)]] as const)
        : []),
    ] as const;
    const cohorts = [...new Set(observations.map((item) => item.cohort))].sort();
    for (const cohort of cohorts) {
      for (const [partition, items] of partitions) {
        const selected = items
          .filter((item) => item.cohort === cohort)
          .map((item) => item.returnPct);
        const baseline = items
          .filter((item) => item.cohort !== cohort)
          .map((item) => item.returnPct);
        const selectedMean = selected.length === 0 ? null : mean(selected);
        const baselineMean = baseline.length === 0 ? null : mean(baseline);
        const horizonSeconds =
          horizon === "1m"
            ? 60
            : horizon === "5m"
              ? 300
              : horizon === "15m"
                ? 900
                : horizon === "1h"
                  ? 3600
                  : horizon === "6h"
                    ? 21_600
                    : 86_400;
        const robustnessObservation = (item: CategoricalFlowObservation) => ({
          observationId: item.eventId,
          episodeId: item.episodeId ?? item.eventId,
          observedAt: item.eventAt,
          horizonSeconds,
          value: item.returnPct,
          magnitude: 1,
          ...(item.regime === undefined ? {} : { regime: item.regime }),
        });
        cells.push({
          horizon,
          cohort,
          partition,
          sampleSize: selected.length,
          baselineSize: baseline.length,
          meanReturnPct: selectedMean,
          baselineMeanReturnPct: baselineMean,
          effectPct:
            selectedMean === null || baselineMean === null ? null : selectedMean - baselineMean,
          pValue: deterministicPermutationPValue(
            selected,
            baseline,
            permutations,
            `${input.seed}:${horizon}:${cohort}:${partition}`,
          ),
          adjustedPValue: null,
          randomizedTimestampPValue: randomizedTimestampAlignmentPValue(
            items,
            cohort,
            randomizedTimestampTrials,
            `${input.seed}:${horizon}:${cohort}:${partition}:timestamp-alignment`,
          ),
          significant: false,
          robustness: analyzeCandidateRobustness({
            selected: items.filter((item) => item.cohort === cohort).map(robustnessObservation),
            baseline: items.filter((item) => item.cohort !== cohort).map(robustnessObservation),
            seed: createHash("sha256")
              .update(`${input.seed}:${horizon}:${cohort}:${partition}`)
              .digest()
              .readUInt32BE(0),
            materialityPolicy: {
              version: 1,
              featureFamily: "DIRECTION",
              horizonSeconds,
              minimumAbsoluteEffect: horizonSeconds <= 900 ? 0.2 : 0.5,
              hypotheticalSpread: 0.04,
              hypotheticalFee: 0.1,
              hypotheticalSlippage: 0.1,
              hypotheticalLatencyCost: 0.02,
            },
          }),
        });
      }
    }
  }
  const eligible = cells
    .map((cell, index) => ({ cell, index }))
    .filter(
      ({ cell }) =>
        cell.partition === "DEVELOPMENT" &&
        cell.sampleSize >= input.minimumSampleSize &&
        cell.baselineSize >= input.minimumSampleSize &&
        cell.pValue !== null,
    )
    .sort((left, right) => (left.cell.pValue ?? 1) - (right.cell.pValue ?? 1));
  const adjusted = new Map<number, number>();
  let next = 1;
  for (let position = eligible.length - 1; position >= 0; position -= 1) {
    // Position is bounded by the local eligible array length.
    // eslint-disable-next-line security/detect-object-injection
    const item = eligible[position];
    if (!item) continue;
    next = Math.min(next, ((item.cell.pValue ?? 1) * eligible.length) / (position + 1));
    adjusted.set(item.index, next);
  }
  const corrected = cells.map((cell, index) => {
    const adjustedPValue = adjusted.get(index) ?? null;
    return {
      ...cell,
      adjustedPValue,
      significant:
        adjustedPValue !== null &&
        adjustedPValue <= input.falseDiscoveryRate &&
        cell.randomizedTimestampPValue !== null &&
        cell.randomizedTimestampPValue <= input.falseDiscoveryRate,
    };
  });
  return {
    status: corrected.some((cell) => cell.adjustedPValue !== null)
      ? "COMPLETE"
      : "INSUFFICIENT_DATA",
    observationCount: parsed.length,
    minimumSampleSize: input.minimumSampleSize,
    permutationCount: permutations,
    randomizedTimestampTrials,
    holdoutAccessed: input.openHoldout === true,
    cells: corrected,
  };
}
