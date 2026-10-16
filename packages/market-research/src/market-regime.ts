import { contentHash } from "@autonomous-trading-lab/domain";
import { z } from "zod";

const ObservationSchema = z
  .object({
    observedAt: z.iso.datetime({ offset: true }),
    price: z.number().positive(),
    evidenceRef: z.string().min(1),
  })
  .strict();

export interface MarketRegimeResult {
  readonly asOf: string;
  readonly state: "RISING" | "FALLING" | "VOLATILE" | "QUIET" | "INSUFFICIENT_DATA";
  readonly windowSeconds: number;
  readonly sampleSize: number;
  readonly returnPct: number | null;
  readonly realizedVolatilityPct: number | null;
  readonly evidenceRefs: readonly string[];
  readonly configHash: `sha256:${string}`;
}

export function classifyMarketRegime(input: {
  readonly observations: readonly {
    readonly observedAt: string;
    readonly price: number;
    readonly evidenceRef: string;
  }[];
  readonly asOf: string;
  readonly windowSeconds: number;
  readonly minimumSamples: number;
  readonly directionThresholdPct: number;
  readonly volatilityThresholdPct: number;
}): MarketRegimeResult {
  const asOfMs = new Date(input.asOf).getTime();
  if (!Number.isFinite(asOfMs)) throw new Error("invalid regime as-of timestamp");
  if (!Number.isInteger(input.windowSeconds) || input.windowSeconds < 60)
    throw new Error("regime window must be at least 60 seconds");
  if (!Number.isInteger(input.minimumSamples) || input.minimumSamples < 3)
    throw new Error("regime minimum samples must be at least three");
  if (input.directionThresholdPct <= 0 || input.volatilityThresholdPct <= 0)
    throw new Error("regime thresholds must be positive");
  const cutoff = asOfMs - input.windowSeconds * 1000;
  const observations = input.observations
    .map((observation) => ObservationSchema.parse(observation))
    .filter((observation) => {
      const timestamp = new Date(observation.observedAt).getTime();
      return timestamp >= cutoff && timestamp <= asOfMs;
    })
    .sort(
      (left, right) =>
        left.observedAt.localeCompare(right.observedAt) ||
        left.evidenceRef.localeCompare(right.evidenceRef),
    );
  const configHash = contentHash({
    windowSeconds: input.windowSeconds,
    minimumSamples: input.minimumSamples,
    directionThresholdPct: input.directionThresholdPct,
    volatilityThresholdPct: input.volatilityThresholdPct,
  });
  if (observations.length < input.minimumSamples)
    return {
      asOf: input.asOf,
      state: "INSUFFICIENT_DATA",
      windowSeconds: input.windowSeconds,
      sampleSize: observations.length,
      returnPct: null,
      realizedVolatilityPct: null,
      evidenceRefs: observations.map((observation) => observation.evidenceRef),
      configHash,
    };
  const first = observations[0];
  const last = observations.at(-1);
  if (!first || !last) throw new Error("regime observations unexpectedly empty");
  const returns: number[] = [];
  for (let index = 1; index < observations.length; index += 1) {
    // The index is bounded by the local validated observation array.
    const previous = observations[index - 1];
    // eslint-disable-next-line security/detect-object-injection
    const current = observations[index];
    if (!previous || !current) throw new Error("invalid regime observation index");
    returns.push(((current.price - previous.price) / previous.price) * 100);
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  const realizedVolatilityPct = Math.sqrt(variance);
  const returnPct = ((last.price - first.price) / first.price) * 100;
  const state =
    realizedVolatilityPct >= input.volatilityThresholdPct
      ? "VOLATILE"
      : returnPct >= input.directionThresholdPct
        ? "RISING"
        : returnPct <= -input.directionThresholdPct
          ? "FALLING"
          : "QUIET";
  return {
    asOf: input.asOf,
    state,
    windowSeconds: input.windowSeconds,
    sampleSize: observations.length,
    returnPct,
    realizedVolatilityPct,
    evidenceRefs: observations.map((observation) => observation.evidenceRef),
    configHash,
  };
}
