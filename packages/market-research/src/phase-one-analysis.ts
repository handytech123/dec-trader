import { createHash } from "node:crypto";
import { z } from "zod";
import { deterministicPermutationPValue } from "./permutation.js";
import { analyzeCandidateRobustness } from "./robustness.js";

const HorizonSchema = z.enum(["1m", "5m", "15m", "1h", "6h", "24h"]);

export const TransferOutcomeObservationSchema = z
  .object({
    eventId: z.string().min(1),
    eventAt: z.iso.datetime({ offset: true }),
    horizon: HorizonSchema,
    quantity: z.number().nonnegative(),
    returnPct: z.number(),
    episodeId: z.string().min(1).optional(),
    regime: z.string().min(1).optional(),
  })
  .strict();
export type TransferOutcomeObservation = z.infer<typeof TransferOutcomeObservationSchema>;

export interface TransferMagnitudeCell {
  readonly horizon: z.infer<typeof HorizonSchema>;
  readonly threshold: number;
  readonly partition: "DEVELOPMENT" | "HOLDOUT";
  readonly sampleSize: number;
  readonly baselineSize: number;
  readonly meanReturnPct: number | null;
  readonly baselineMeanReturnPct: number | null;
  readonly effectPct: number | null;
  readonly pValue: number | null;
  readonly adjustedPValue: number | null;
  readonly significant: boolean;
  readonly robustness: ReturnType<typeof analyzeCandidateRobustness>;
}

export interface TransferMagnitudeAnalysis {
  readonly status: "COMPLETE" | "INSUFFICIENT_DATA";
  readonly observationCount: number;
  readonly analyzableCount: number;
  readonly minimumHistory: number;
  readonly minimumSampleSize: number;
  readonly permutationCount: number;
  readonly holdoutAccessed: boolean;
  readonly falsification: {
    readonly control: "REMOVE_LARGEST_FIVE";
    readonly testedFindingCount: number;
    readonly survivingFindingCount: number;
    readonly randomizedTimestampAlignment: {
      readonly control: "RANDOMIZED_TIMESTAMP_ALIGNMENT";
      readonly trialCount: number;
      readonly testedFindingCount: number;
      readonly survivingFindingCount: number;
    };
  };
  readonly cells: readonly TransferMagnitudeCell[];
}

interface ScoredObservation extends TransferOutcomeObservation {
  readonly zScore: number;
}

interface RandomizedAlignmentCell {
  readonly key: string;
  readonly pValue: number | null;
  readonly adjustedPValue: number | null;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pointInTimeZScores(
  observations: readonly TransferOutcomeObservation[],
  minimumHistory: number,
): readonly ScoredObservation[] {
  const sorted = [...observations].sort(
    (left, right) =>
      left.eventAt.localeCompare(right.eventAt) || left.eventId.localeCompare(right.eventId),
  );
  let count = 0;
  let runningMean = 0;
  let sumSquaredDifferences = 0;
  const scored: ScoredObservation[] = [];
  for (const observation of sorted) {
    if (count >= minimumHistory && count > 1) {
      const standardDeviation = Math.sqrt(sumSquaredDifferences / (count - 1));
      if (standardDeviation > 0)
        scored.push({
          ...observation,
          zScore: (observation.quantity - runningMean) / standardDeviation,
        });
    }
    count += 1;
    const difference = observation.quantity - runningMean;
    runningMean += difference / count;
    sumSquaredDifferences += difference * (observation.quantity - runningMean);
  }
  return scored;
}

function randomizedAlignmentPValue(
  observations: readonly ScoredObservation[],
  threshold: number,
  trials: number,
  seed: string,
): number | null {
  const selectedIndexes = observations
    .map((observation, index) => ({ observation, index }))
    .filter(({ observation }) => observation.zScore > threshold)
    .map(({ index }) => index);
  if (selectedIndexes.length === 0 || selectedIndexes.length === observations.length) return null;
  const returns = observations.map((observation) => observation.returnPct);
  const total = returns.reduce((sum, value) => sum + value, 0);
  const selectedTotal = selectedIndexes.reduce((sum, index) => sum + (returns.at(index) ?? 0), 0);
  const baselineSize = returns.length - selectedIndexes.length;
  const observed = Math.abs(
    selectedTotal / selectedIndexes.length - (total - selectedTotal) / baselineSize,
  );
  let extreme = 0;
  for (let trial = 0; trial < trials; trial += 1) {
    const digest = createHash("sha256")
      .update(`${seed}:${String(trial)}`)
      .digest();
    const offset = (digest.readUInt32BE(0) % (returns.length - 1)) + 1;
    const randomizedSelectedTotal = selectedIndexes.reduce(
      (sum, index) => sum + (returns.at((index + offset) % returns.length) ?? 0),
      0,
    );
    const randomizedEffect = Math.abs(
      randomizedSelectedTotal / selectedIndexes.length -
        (total - randomizedSelectedTotal) / baselineSize,
    );
    if (randomizedEffect >= observed) extreme += 1;
  }
  return (extreme + 1) / (trials + 1);
}

function adjustRandomizedAlignment(
  cells: readonly Omit<RandomizedAlignmentCell, "adjustedPValue">[],
): readonly RandomizedAlignmentCell[] {
  const eligible = cells
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => cell.pValue !== null)
    .sort((left, right) => (left.cell.pValue ?? 1) - (right.cell.pValue ?? 1));
  const adjusted = new Map<number, number>();
  let next = 1;
  for (let position = eligible.length - 1; position >= 0; position -= 1) {
    const item = eligible.at(position);
    if (!item) continue;
    next = Math.min(next, ((item.cell.pValue ?? 1) * eligible.length) / (position + 1));
    adjusted.set(item.index, next);
  }
  return cells.map((cell, index) => ({ ...cell, adjustedPValue: adjusted.get(index) ?? null }));
}

function makeCell(
  observations: readonly ScoredObservation[],
  horizon: z.infer<typeof HorizonSchema>,
  threshold: number,
  partition: "DEVELOPMENT" | "HOLDOUT",
  permutations: number,
  seed: string,
): TransferMagnitudeCell {
  const selectedObservations = observations.filter((item) => item.zScore > threshold);
  const baselineObservations = observations.filter((item) => item.zScore <= threshold);
  const selected = selectedObservations.map((item) => item.returnPct);
  const baseline = baselineObservations.map((item) => item.returnPct);
  const selectedMean = selected.length === 0 ? null : mean(selected);
  const baselineMean = baseline.length === 0 ? null : mean(baseline);
  const pValue = deterministicPermutationPValue(selected, baseline, permutations, seed);
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
  const minimumAbsoluteEffect =
    horizon === "1m"
      ? 0.1
      : horizon === "5m"
        ? 0.15
        : horizon === "15m"
          ? 0.2
          : horizon === "1h"
            ? 0.3
            : horizon === "6h"
              ? 0.5
              : 0.75;
  const robustnessObservation = (item: ScoredObservation) => ({
    observationId: item.eventId,
    episodeId: item.episodeId ?? item.eventId,
    observedAt: item.eventAt,
    horizonSeconds,
    value: item.returnPct,
    magnitude: item.quantity,
    ...(item.regime === undefined ? {} : { regime: item.regime }),
  });
  const seedNumber = createHash("sha256").update(seed).digest().readUInt32BE(0);
  return {
    horizon,
    threshold,
    partition,
    sampleSize: selected.length,
    baselineSize: baseline.length,
    meanReturnPct: selectedMean,
    baselineMeanReturnPct: baselineMean,
    effectPct: selectedMean === null || baselineMean === null ? null : selectedMean - baselineMean,
    pValue,
    adjustedPValue: null,
    significant: false,
    robustness: analyzeCandidateRobustness({
      selected: selectedObservations.map(robustnessObservation),
      baseline: baselineObservations.map(robustnessObservation),
      seed: seedNumber,
      materialityPolicy: {
        version: 1,
        featureFamily: "TRANSFER_MAGNITUDE",
        horizonSeconds,
        minimumAbsoluteEffect,
        hypotheticalSpread: 0.04,
        hypotheticalFee: 0.1,
        hypotheticalSlippage: 0.1,
        hypotheticalLatencyCost: 0.02,
      },
    }),
  };
}

function applyBenjaminiHochberg(
  cells: readonly TransferMagnitudeCell[],
  falseDiscoveryRate: number,
  minimumSampleSize: number,
): readonly TransferMagnitudeCell[] {
  const eligible = cells
    .map((cell, index) => ({ cell, index }))
    .filter(
      ({ cell }) =>
        cell.partition === "DEVELOPMENT" &&
        cell.sampleSize >= minimumSampleSize &&
        cell.baselineSize >= minimumSampleSize &&
        cell.pValue !== null,
    )
    .sort((left, right) => (left.cell.pValue ?? 1) - (right.cell.pValue ?? 1));
  const adjusted = new Map<number, number>();
  let next = 1;
  for (let position = eligible.length - 1; position >= 0; position -= 1) {
    const item = eligible.at(position);
    if (!item) continue;
    next = Math.min(next, ((item.cell.pValue ?? 1) * eligible.length) / (position + 1));
    adjusted.set(item.index, next);
  }
  return cells.map((cell, index) => {
    const adjustedPValue = adjusted.get(index) ?? null;
    return {
      ...cell,
      adjustedPValue,
      significant: adjustedPValue !== null && adjustedPValue <= falseDiscoveryRate,
    };
  });
}

export function analyzeTransferMagnitude(input: {
  readonly observations: readonly TransferOutcomeObservation[];
  readonly datasetCutoff: string;
  readonly thresholds: readonly number[];
  readonly minimumHistory?: number;
  readonly minimumSampleSize: number;
  readonly holdoutFraction: number;
  readonly falseDiscoveryRate: number;
  readonly permutations?: number;
  readonly seed: string;
  readonly openHoldout?: boolean;
}): TransferMagnitudeAnalysis {
  const cutoff = new Date(input.datasetCutoff).getTime();
  if (!Number.isFinite(cutoff)) throw new Error("invalid dataset cutoff");
  if (input.holdoutFraction <= 0 || input.holdoutFraction >= 0.5)
    throw new Error("holdout fraction must be between zero and one half");
  const minimumHistory = input.minimumHistory ?? 30;
  const permutations = input.permutations ?? 999;
  if (!Number.isInteger(permutations) || permutations < 99)
    throw new Error("at least 99 permutations are required");
  const parsed = input.observations
    .map((observation) => TransferOutcomeObservationSchema.parse(observation))
    .filter((observation) => new Date(observation.eventAt).getTime() <= cutoff);
  const cells: TransferMagnitudeCell[] = [];
  const removeLargestFiveCells: TransferMagnitudeCell[] = [];
  const randomizedAlignmentCells: Omit<RandomizedAlignmentCell, "adjustedPValue">[] = [];
  const randomizedAlignmentTrials = 99;
  let analyzableCount = 0;
  for (const horizon of HorizonSchema.options) {
    const horizonObservations = parsed.filter((observation) => observation.horizon === horizon);
    const scored = pointInTimeZScores(horizonObservations, minimumHistory);
    analyzableCount += scored.length;
    const holdoutSize = Math.floor(scored.length * input.holdoutFraction);
    const development = scored.slice(0, scored.length - holdoutSize);
    const holdout = holdoutSize === 0 ? [] : scored.slice(-holdoutSize);
    const largestFiveIds = new Set(
      [...development]
        .sort(
          (left, right) =>
            right.quantity - left.quantity || left.eventId.localeCompare(right.eventId),
        )
        .slice(0, 5)
        .map((observation) => observation.eventId),
    );
    const withoutLargestFive = development.filter(
      (observation) => !largestFiveIds.has(observation.eventId),
    );
    for (const threshold of input.thresholds) {
      cells.push(
        makeCell(
          development,
          horizon,
          threshold,
          "DEVELOPMENT",
          permutations,
          `${input.seed}:${horizon}:${String(threshold)}:development`,
        ),
      );
      if (input.openHoldout === true)
        cells.push(
          makeCell(
            holdout,
            horizon,
            threshold,
            "HOLDOUT",
            permutations,
            `${input.seed}:${horizon}:${String(threshold)}:holdout`,
          ),
        );
      removeLargestFiveCells.push(
        makeCell(
          withoutLargestFive,
          horizon,
          threshold,
          "DEVELOPMENT",
          permutations,
          `${input.seed}:${horizon}:${String(threshold)}:remove-largest-five`,
        ),
      );
      randomizedAlignmentCells.push({
        key: `${horizon}:${String(threshold)}`,
        pValue: randomizedAlignmentPValue(
          development,
          threshold,
          randomizedAlignmentTrials,
          `${input.seed}:${horizon}:${String(threshold)}:randomized-alignment`,
        ),
      });
    }
  }
  const corrected = applyBenjaminiHochberg(
    cells,
    input.falseDiscoveryRate,
    input.minimumSampleSize,
  );
  const correctedSensitivity = applyBenjaminiHochberg(
    removeLargestFiveCells,
    input.falseDiscoveryRate,
    input.minimumSampleSize,
  );
  const developmentFindings = corrected.filter(
    (cell) => cell.partition === "DEVELOPMENT" && cell.significant,
  );
  const sensitivityByKey = new Map(
    correctedSensitivity.map(
      (cell) => [`${cell.horizon}:${String(cell.threshold)}`, cell] as const,
    ),
  );
  const survivingFindingCount = developmentFindings.filter((finding) => {
    const sensitivity = sensitivityByKey.get(`${finding.horizon}:${String(finding.threshold)}`);
    return (
      sensitivity?.significant === true &&
      Math.sign(sensitivity.effectPct ?? 0) === Math.sign(finding.effectPct ?? 0)
    );
  }).length;
  const randomizedAlignmentByKey = new Map(
    adjustRandomizedAlignment(randomizedAlignmentCells).map((cell) => [cell.key, cell] as const),
  );
  const randomizedAlignmentSurvivingCount = developmentFindings.filter((finding) => {
    const cell = randomizedAlignmentByKey.get(`${finding.horizon}:${String(finding.threshold)}`);
    return cell?.adjustedPValue !== null && (cell?.adjustedPValue ?? 1) <= input.falseDiscoveryRate;
  }).length;
  return {
    status: corrected.some((cell) => cell.adjustedPValue !== null)
      ? "COMPLETE"
      : "INSUFFICIENT_DATA",
    observationCount: parsed.length,
    analyzableCount,
    minimumHistory,
    minimumSampleSize: input.minimumSampleSize,
    permutationCount: permutations,
    holdoutAccessed: input.openHoldout === true,
    falsification: {
      control: "REMOVE_LARGEST_FIVE",
      testedFindingCount: developmentFindings.length,
      survivingFindingCount,
      randomizedTimestampAlignment: {
        control: "RANDOMIZED_TIMESTAMP_ALIGNMENT",
        trialCount: randomizedAlignmentTrials,
        testedFindingCount: developmentFindings.length,
        survivingFindingCount: randomizedAlignmentSurvivingCount,
      },
    },
    cells: corrected,
  };
}
