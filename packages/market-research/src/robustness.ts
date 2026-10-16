import {
  clusterBootstrapMean,
  overlapDiagnostics,
  selectDeterministicNonOverlapping,
} from "./dependence.js";
import {
  evaluateEconomicMateriality,
  summarizeReturnEffect,
  type MaterialityPolicy,
} from "./effect-size.js";
import { extremeObservationSensitivity } from "./falsification.js";
import { walkForwardEffect } from "./walk-forward.js";

export interface RobustnessObservation {
  readonly observationId: string;
  readonly episodeId: string;
  readonly observedAt: string;
  readonly horizonSeconds: number;
  readonly value: number;
  readonly magnitude: number;
  readonly regime?: string;
}

export function analyzeCandidateRobustness(input: {
  readonly selected: readonly RobustnessObservation[];
  readonly baseline: readonly RobustnessObservation[];
  readonly seed: number;
  readonly materialityPolicy: MaterialityPolicy;
}) {
  if (input.selected.length === 0 || input.baseline.length === 0)
    return { status: "INSUFFICIENT_DATA" as const };
  const baselineMean =
    input.baseline.reduce((sum, observation) => sum + observation.value, 0) / input.baseline.length;
  const centered = input.selected.map((observation) => ({
    observationId: observation.observationId,
    episodeId: observation.episodeId,
    eventTime: observation.observedAt,
    horizonSeconds: observation.horizonSeconds,
    value: observation.value - baselineMean,
    ...(observation.regime === undefined ? {} : { regime: observation.regime }),
  }));
  const nonOverlapping = selectDeterministicNonOverlapping(centered);
  const fullEffect = summarizeReturnEffect(
    input.selected.map((observation) => observation.value),
    input.selected.map(() => baselineMean),
  );
  const nonOverlappingEffect = summarizeReturnEffect(
    nonOverlapping.map((observation) => observation.value + baselineMean),
    nonOverlapping.map(() => baselineMean),
  );
  const maximumInferenceObservations = 5000;
  const inferenceSample =
    centered.length <= maximumInferenceObservations
      ? centered
      : Array.from({ length: maximumInferenceObservations }, (_, index) => {
          const selectedIndex = Math.floor(
            (index * centered.length) / maximumInferenceObservations,
          );
          const observation = centered.at(selectedIndex);
          if (!observation) throw new Error("systematic inference sample index is invalid");
          return observation;
        });
  const bootstrapInput = {
    seed: input.seed,
    iterations: 499,
    confidenceLevel: 0.95,
  } as const;
  const byEpisode = clusterBootstrapMean(inferenceSample, {
    ...bootstrapInput,
    clusterDefinition: "EPISODE",
  });
  const byUtcDay = clusterBootstrapMean(inferenceSample, {
    ...bootstrapInput,
    clusterDefinition: "UTC_DAY",
  });
  const byRegime = inferenceSample.every((observation) => observation.regime !== undefined)
    ? clusterBootstrapMean(inferenceSample, {
        ...bootstrapInput,
        clusterDefinition: "MARKET_REGIME",
      })
    : null;
  const materiality = evaluateEconomicMateriality(
    fullEffect.differenceVersusBaseline,
    input.materialityPolicy,
  );
  const sensitivity = extremeObservationSensitivity(
    input.selected.map((observation) => ({
      observationId: observation.observationId,
      magnitude: observation.magnitude,
      value: observation.value - baselineMean,
    })),
    [1, 3, 5, Math.ceil(input.selected.length * 0.01)],
  );
  const sameDirection =
    Math.sign(fullEffect.differenceVersusBaseline) ===
    Math.sign(nonOverlappingEffect.differenceVersusBaseline);
  const combined = [
    ...input.selected.map((observation) => ({ ...observation, candidate: true })),
    ...input.baseline.map((observation) => ({ ...observation, candidate: false })),
  ].sort(
    (left, right) =>
      left.observedAt.localeCompare(right.observedAt) ||
      left.observationId.localeCompare(right.observationId),
  );
  const minimumDevelopmentSize = Math.max(2, Math.floor(combined.length * 0.5));
  const evaluationWindowSize = Math.max(1, Math.floor(combined.length * 0.1));
  const walkForward = walkForwardEffect({
    observations: combined,
    mode: "EXPANDING",
    minimumDevelopmentSize,
    evaluationWindowSize,
  });
  return {
    status: "COMPLETE" as const,
    overlap: overlapDiagnostics(centered),
    fullEffect,
    nonOverlappingEffect,
    clusterBootstrap: {
      populationObservationCount: centered.length,
      inferenceObservationCount: inferenceSample.length,
      samplingMethod:
        inferenceSample.length === centered.length ? "FULL_POPULATION" : "SYSTEMATIC_TIME_SAMPLE",
      byEpisode,
      byUtcDay,
      byRegime,
    },
    materiality,
    extremeObservationSensitivity: sensitivity,
    walkForward,
    overlapDependent:
      !sameDirection ||
      Math.abs(nonOverlappingEffect.differenceVersusBaseline) <
        Math.abs(fullEffect.differenceVersusBaseline) * 0.5,
  };
}
