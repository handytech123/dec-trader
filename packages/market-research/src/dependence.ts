import { contentHash } from "@autonomous-trading-lab/domain";

export interface DependentObservation {
  readonly observationId: string;
  readonly episodeId: string;
  readonly eventTime: string;
  readonly horizonSeconds: number;
  readonly value: number;
  readonly regime?: string;
}

export interface OverlapDiagnostics {
  readonly totalObservations: number;
  readonly uniqueEpisodes: number;
  readonly overlappingObservations: number;
  readonly overlapPercentage: number;
  readonly maximumOverlapDensity: number;
  readonly effectiveNonOverlappingSampleCount: number;
}

const interval = (observation: DependentObservation): readonly [number, number] => {
  const start = new Date(observation.eventTime).getTime();
  if (!Number.isFinite(start) || observation.horizonSeconds <= 0)
    throw new Error("observation interval is invalid");
  return [start, start + observation.horizonSeconds * 1000];
};

export function selectDeterministicNonOverlapping(
  observations: readonly DependentObservation[],
): readonly DependentObservation[] {
  const sorted = [...observations].sort((left, right) => {
    const [leftStart, leftEnd] = interval(left);
    const [rightStart, rightEnd] = interval(right);
    return (
      leftEnd - rightEnd ||
      leftStart - rightStart ||
      left.observationId.localeCompare(right.observationId)
    );
  });
  const selected: DependentObservation[] = [];
  let lastEnd = Number.NEGATIVE_INFINITY;
  for (const observation of sorted) {
    const [start, end] = interval(observation);
    if (start >= lastEnd) {
      selected.push(observation);
      lastEnd = end;
    }
  }
  return selected;
}

export function overlapDiagnostics(
  observations: readonly DependentObservation[],
): OverlapDiagnostics {
  const intervals = observations
    .map((observation) => ({
      observation,
      interval: interval(observation),
    }))
    .sort(
      (left, right) =>
        left.interval[0] - right.interval[0] ||
        left.interval[1] - right.interval[1] ||
        left.observation.observationId.localeCompare(right.observation.observationId),
    );
  const overlapping = new Set<string>();
  let maximumPriorEnd = Number.NEGATIVE_INFINITY;
  for (const [index, current] of intervals.entries()) {
    const nextStart = intervals.at(index + 1)?.interval[0] ?? Number.POSITIVE_INFINITY;
    if (maximumPriorEnd > current.interval[0] || nextStart < current.interval[1])
      overlapping.add(current.observation.observationId);
    maximumPriorEnd = Math.max(maximumPriorEnd, current.interval[1]);
  }
  const points = intervals
    .flatMap(({ interval: [start, end] }) => [
      { time: start, delta: 1 },
      { time: end, delta: -1 },
    ])
    .sort((left, right) => left.time - right.time || left.delta - right.delta);
  let density = 0;
  let maximumOverlapDensity = 0;
  for (const point of points) {
    density += point.delta;
    maximumOverlapDensity = Math.max(maximumOverlapDensity, density);
  }
  const total = observations.length;
  return {
    totalObservations: total,
    uniqueEpisodes: new Set(observations.map((observation) => observation.episodeId)).size,
    overlappingObservations: overlapping.size,
    overlapPercentage: total === 0 ? 0 : (overlapping.size / total) * 100,
    maximumOverlapDensity,
    effectiveNonOverlappingSampleCount: selectDeterministicNonOverlapping(observations).length,
  };
}

export type ClusterDefinition = "EPISODE" | "UTC_DAY" | "MARKET_REGIME";

export interface ClusterBootstrapResult {
  readonly method: "CLUSTER_BOOTSTRAP_MEAN";
  readonly clusterDefinition: ClusterDefinition;
  readonly seed: number;
  readonly iterations: number;
  readonly confidenceLevel: number;
  readonly clusterCount: number;
  readonly estimate: number;
  readonly confidenceInterval: readonly [number, number];
  readonly configurationHash: `sha256:${string}`;
}

const mulberry32 = (seed: number): (() => number) => {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const quantile = (sorted: readonly number[], probability: number): number => {
  if (sorted.length === 0) throw new Error("cannot calculate an empty quantile");
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const fraction = index - lower;
  const lowerValue = sorted.at(lower);
  if (lowerValue === undefined) throw new Error("quantile index is invalid");
  return lowerValue + ((sorted.at(lower + 1) ?? lowerValue) - lowerValue) * fraction;
};

export function clusterBootstrapMean(
  observations: readonly DependentObservation[],
  input: {
    readonly clusterDefinition: ClusterDefinition;
    readonly seed: number;
    readonly iterations: number;
    readonly confidenceLevel?: number;
  },
): ClusterBootstrapResult {
  if (observations.length === 0) throw new Error("bootstrap requires observations");
  if (!Number.isInteger(input.seed)) throw new Error("bootstrap seed must be an integer");
  if (!Number.isInteger(input.iterations) || input.iterations < 100 || input.iterations > 1_000_000)
    throw new Error("bootstrap iterations must be between 100 and 1000000");
  const confidenceLevel = input.confidenceLevel ?? 0.95;
  if (!(confidenceLevel > 0 && confidenceLevel < 1)) throw new Error("invalid confidence level");
  const clusterKey = (observation: DependentObservation): string => {
    if (input.clusterDefinition === "EPISODE") return observation.episodeId;
    if (input.clusterDefinition === "UTC_DAY") return observation.eventTime.slice(0, 10);
    if (!observation.regime) throw new Error("market-regime clustering requires regime labels");
    return observation.regime;
  };
  const clusters = new Map<string, DependentObservation[]>();
  for (const observation of observations) {
    const key = clusterKey(observation);
    const values = clusters.get(key) ?? [];
    values.push(observation);
    clusters.set(key, values);
  }
  const entries = [...clusters.entries()].sort(([left], [right]) => left.localeCompare(right));
  const random = mulberry32(input.seed);
  const distribution: number[] = [];
  for (let iteration = 0; iteration < input.iterations; iteration += 1) {
    const sample: number[] = [];
    let drawsRemaining = entries.length;
    while (drawsRemaining > 0) {
      const cluster = entries.at(Math.floor(random() * entries.length))?.[1];
      if (!cluster) throw new Error("bootstrap cluster selection failed");
      sample.push(...cluster.map((observation) => observation.value));
      drawsRemaining -= 1;
    }
    distribution.push(sample.reduce((sum, value) => sum + value, 0) / sample.length);
  }
  distribution.sort((left, right) => left - right);
  const alpha = (1 - confidenceLevel) / 2;
  const configuration = {
    method: "CLUSTER_BOOTSTRAP_MEAN",
    clusterDefinition: input.clusterDefinition,
    seed: input.seed,
    iterations: input.iterations,
    confidenceLevel,
  } as const;
  return {
    ...configuration,
    clusterCount: entries.length,
    estimate:
      observations.reduce((sum, observation) => sum + observation.value, 0) / observations.length,
    confidenceInterval: [quantile(distribution, alpha), quantile(distribution, 1 - alpha)],
    configurationHash: contentHash(configuration),
  };
}
