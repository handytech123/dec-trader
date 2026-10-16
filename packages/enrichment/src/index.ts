import { contentHash } from "@autonomous-trading-lab/domain";
import { z } from "zod";

export const EnrichmentProviderSchema = z.enum(["nansen", "coinglass"]);
export const EnrichmentQualitySchema = z.enum(["VALID", "STALE", "RESTRICTED", "MALFORMED"]);

export const CanonicalEnrichmentObservationSchema = z
  .object({
    observationId: z.string().min(1),
    rawEnrichmentId: z.string().min(1),
    provider: EnrichmentProviderSchema,
    observationType: z.string().min(1),
    subject: z.string().min(1),
    chain: z.string().min(1).optional(),
    scope: z.string().min(1),
    metric: z.string().min(1),
    value: z.unknown(),
    unit: z.string().min(1).optional(),
    eventAt: z.iso.datetime().optional(),
    asOf: z.iso.datetime().optional(),
    retrievedAt: z.iso.datetime(),
    pointInTimeEligible: z.boolean(),
    retrospectiveOnly: z.boolean(),
    freshnessSeconds: z.number().int().nonnegative().optional(),
    quality: EnrichmentQualitySchema,
    parserVersion: z.number().int().positive(),
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.pointInTimeEligible && value.retrospectiveOnly)
      context.addIssue({
        code: "custom",
        message: "retrospective observations cannot be point-in-time eligible",
      });
  });

export type CanonicalEnrichmentObservation = Omit<
  z.infer<typeof CanonicalEnrichmentObservationSchema>,
  "contentHash"
> & { readonly contentHash: `sha256:${string}` };

export function finalizeEnrichmentObservation(
  candidate: Omit<CanonicalEnrichmentObservation, "contentHash">,
): CanonicalEnrichmentObservation {
  return CanonicalEnrichmentObservationSchema.parse({
    ...candidate,
    contentHash: contentHash(candidate),
  }) as CanonicalEnrichmentObservation;
}

export interface EnrichmentBudgetPolicy {
  readonly maximumRequestsPerMinute: number;
  readonly maximumRequestsPerDay: number;
  readonly maximumConcurrency: number;
  readonly cacheTtlMs: number;
  readonly circuitFailureThreshold: number;
  readonly circuitResetMs: number;
}

interface CacheEntry<T> {
  readonly expiresAt: number;
  readonly value: T;
}

export class BoundedEnrichmentRuntime {
  readonly #cache = new Map<string, CacheEntry<unknown>>();
  readonly #inFlight = new Map<string, Promise<unknown>>();
  readonly #minuteRequests: number[] = [];
  readonly #dayRequests: number[] = [];
  #active = 0;
  #failureCount = 0;
  #circuitOpenedAt: number | undefined;

  public constructor(readonly policy: EnrichmentBudgetPolicy) {
    for (const [name, value] of Object.entries(policy)) {
      if (!Number.isInteger(value) || value < 1)
        throw new Error(`${name} must be a positive integer`);
    }
  }

  public async execute<T>(key: string, operation: () => Promise<T>, now = Date.now()): Promise<T> {
    const cached = this.#cache.get(key) as CacheEntry<T> | undefined;
    if (cached && cached.expiresAt > now) return cached.value;
    const existing = this.#inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    while ((this.#minuteRequests[0] ?? now) <= now - 60_000) this.#minuteRequests.shift();
    while ((this.#dayRequests[0] ?? now) <= now - 86_400_000) this.#dayRequests.shift();
    if (
      this.#circuitOpenedAt !== undefined &&
      now - this.#circuitOpenedAt < this.policy.circuitResetMs
    )
      throw new Error("enrichment circuit is open");
    if (this.#active >= this.policy.maximumConcurrency)
      throw new Error("enrichment concurrency budget exhausted");
    if (this.#minuteRequests.length >= this.policy.maximumRequestsPerMinute)
      throw new Error("enrichment minute budget exhausted");
    if (this.#dayRequests.length >= this.policy.maximumRequestsPerDay)
      throw new Error("enrichment daily budget exhausted");
    this.#active += 1;
    this.#minuteRequests.push(now);
    this.#dayRequests.push(now);
    const pending = operation()
      .then((value) => {
        this.#failureCount = 0;
        this.#circuitOpenedAt = undefined;
        this.#cache.set(key, { expiresAt: now + this.policy.cacheTtlMs, value });
        return value;
      })
      .catch((error: unknown) => {
        this.#failureCount += 1;
        if (this.#failureCount >= this.policy.circuitFailureThreshold) this.#circuitOpenedAt = now;
        throw error;
      })
      .finally(() => {
        this.#active -= 1;
        this.#inFlight.delete(key);
      });
    this.#inFlight.set(key, pending);
    return pending;
  }
}

export function assertAblationPopulationEquality(
  variants: Readonly<Record<string, readonly string[]>>,
) {
  const entries = Object.entries(variants);
  if (
    entries.length !== 4 ||
    !["CFIE_BASE", "CFIE_NANSEN", "CFIE_COINGLASS", "CFIE_NANSEN_COINGLASS"].every(
      (name) => name in variants,
    )
  )
    throw new Error("all four enrichment ablation variants are required");
  const baseline = [...(variants.CFIE_BASE ?? [])].sort();
  const mismatches = entries
    .filter(([, ids]) => JSON.stringify([...ids].sort()) !== JSON.stringify(baseline))
    .map(([name]) => name);
  return {
    eligible: mismatches.length === 0,
    populationHash: contentHash(baseline),
    mismatches,
  } as const;
}

export interface NansenMetricSnapshot {
  readonly observationId: string;
  readonly subject: string;
  readonly symbol: string;
  readonly retrievedAt: string;
  readonly metric: string;
  readonly value: number;
}

export interface NansenChangeFeature {
  readonly subject: string;
  readonly symbol: string;
  readonly previousRetrievedAt: string;
  readonly currentRetrievedAt: string;
  readonly holdingsValueUsd: number;
  readonly holdingsValueDeltaUsd: number;
  readonly holdingsValueDeltaPct: number | null;
  readonly holdersCountDelta: number;
  readonly holdingsShareDeltaPct: number;
  readonly reportedBalance24hChangePct: number;
  readonly marketCapNormalizedHoldings: number | null;
  readonly crossSectionalValueRank: number;
  readonly unusualChangeZScore: number | null;
  readonly sourceObservationIds: readonly string[];
}

const requiredNansenMetrics = [
  "smart_money_holdings_value_usd",
  "smart_money_balance_24h_percent_change",
  "smart_money_holders_count",
  "smart_money_share_of_holdings_percent",
  "token_market_cap_usd",
] as const;

export function buildNansenChangeFeatures(
  observations: readonly NansenMetricSnapshot[],
): readonly NansenChangeFeature[] {
  const snapshots = new Map<string, Map<string, Map<string, NansenMetricSnapshot>>>();
  for (const observation of observations) {
    if (!Number.isFinite(observation.value)) throw new Error("Nansen metric values must be finite");
    const timestamp = new Date(observation.retrievedAt);
    if (!Number.isFinite(timestamp.getTime()))
      throw new Error("invalid Nansen retrieval timestamp");
    const subjectSnapshots =
      snapshots.get(observation.subject) ?? new Map<string, Map<string, NansenMetricSnapshot>>();
    const metrics =
      subjectSnapshots.get(timestamp.toISOString()) ?? new Map<string, NansenMetricSnapshot>();
    if (metrics.has(observation.metric)) throw new Error("duplicate Nansen metric in snapshot");
    metrics.set(observation.metric, observation);
    subjectSnapshots.set(timestamp.toISOString(), metrics);
    snapshots.set(observation.subject, subjectSnapshots);
  }
  const raw: Omit<NansenChangeFeature, "crossSectionalValueRank" | "unusualChangeZScore">[] = [];
  for (const [, subjectSnapshots] of snapshots) {
    const ordered = [...subjectSnapshots.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
    for (let index = 1; index < ordered.length; index += 1) {
      const previousEntry = ordered.at(index - 1);
      const currentEntry = ordered.at(index);
      if (!previousEntry || !currentEntry) continue;
      const [previousRetrievedAt, previous] = previousEntry;
      const [currentRetrievedAt, current] = currentEntry;
      if (!requiredNansenMetrics.every((metric) => previous.has(metric) && current.has(metric)))
        continue;
      const metricValue = (source: Map<string, NansenMetricSnapshot>, metric: string): number => {
        const value = source.get(metric)?.value;
        if (value === undefined) throw new Error(`missing required Nansen metric ${metric}`);
        return value;
      };
      const previousValue = metricValue(previous, "smart_money_holdings_value_usd");
      const currentValue = metricValue(current, "smart_money_holdings_value_usd");
      const marketCap = metricValue(current, "token_market_cap_usd");
      const first = current.values().next().value;
      if (!first) continue;
      raw.push({
        subject: first.subject,
        symbol: first.symbol,
        previousRetrievedAt,
        currentRetrievedAt,
        holdingsValueUsd: currentValue,
        holdingsValueDeltaUsd: currentValue - previousValue,
        holdingsValueDeltaPct:
          previousValue === 0 ? null : ((currentValue - previousValue) / previousValue) * 100,
        holdersCountDelta:
          metricValue(current, "smart_money_holders_count") -
          metricValue(previous, "smart_money_holders_count"),
        holdingsShareDeltaPct:
          metricValue(current, "smart_money_share_of_holdings_percent") -
          metricValue(previous, "smart_money_share_of_holdings_percent"),
        reportedBalance24hChangePct: metricValue(current, "smart_money_balance_24h_percent_change"),
        marketCapNormalizedHoldings: marketCap === 0 ? null : currentValue / marketCap,
        sourceObservationIds: [...previous.values(), ...current.values()]
          .map((item) => item.observationId)
          .sort(),
      });
    }
  }
  const byTimestamp = new Map<string, typeof raw>();
  for (const feature of raw) {
    const peers = byTimestamp.get(feature.currentRetrievedAt) ?? [];
    peers.push(feature);
    byTimestamp.set(feature.currentRetrievedAt, peers);
  }
  return raw.map((feature) => {
    const peers = byTimestamp.get(feature.currentRetrievedAt) ?? [feature];
    const sortedValues = [...peers]
      .sort(
        (left, right) =>
          left.holdingsValueUsd - right.holdingsValueUsd ||
          left.subject.localeCompare(right.subject),
      )
      .map((item) => item.subject);
    const deltas = peers.map((item) => item.holdingsValueDeltaUsd);
    const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
    const variance =
      deltas.length < 2
        ? 0
        : deltas.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (deltas.length - 1);
    const standardDeviation = Math.sqrt(variance);
    return {
      ...feature,
      crossSectionalValueRank:
        sortedValues.length === 1
          ? 1
          : sortedValues.indexOf(feature.subject) / (sortedValues.length - 1),
      unusualChangeZScore:
        standardDeviation === 0 ? null : (feature.holdingsValueDeltaUsd - mean) / standardDeviation,
    };
  });
}

export interface EnrichmentAblationObservation {
  readonly eventId: string;
  readonly eventTime?: string;
  readonly returnPct: number;
  readonly normalSolReturnPct: number;
  readonly btcReturnPct: number | null;
  readonly baseScore: number;
  readonly nansenScore: number | null;
  readonly coinglassScore: number | null;
  readonly regime: string;
  readonly magnitudeBucket?: string;
}

export interface EnrichmentAblationEvaluationOptions {
  readonly bootstrapIterations?: number;
  readonly permutationIterations?: number;
  readonly randomSeed?: number;
}

const correlation = (left: readonly number[], right: readonly number[]): number | null => {
  if (left.length !== right.length || left.length < 2) return null;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  const numerator = left.reduce(
    (sum, value, index) => sum + (value - leftMean) * ((right.at(index) ?? 0) - rightMean),
    0,
  );
  const denominator = Math.sqrt(
    left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0) *
      right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0),
  );
  return denominator === 0 ? null : numerator / denominator;
};

const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const quantile = (values: readonly number[], probability: number): number | null => {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = (ordered.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const low = ordered.at(lower) ?? 0;
  const high = ordered.at(upper) ?? low;
  return low + (high - low) * (index - lower);
};

export function evaluateEnrichmentAblation(
  observations: readonly EnrichmentAblationObservation[],
  options: EnrichmentAblationEvaluationOptions = {},
) {
  if (observations.length === 0) throw new Error("ablation observations are required");
  if (
    observations.some((item) =>
      [
        item.returnPct,
        item.normalSolReturnPct,
        item.btcReturnPct ?? 0,
        item.baseScore,
        item.nansenScore ?? 0,
        item.coinglassScore ?? 0,
      ].some((value) => !Number.isFinite(value)),
    )
  )
    throw new Error("ablation values must be finite");
  const eventIds = observations.map((item) => item.eventId);
  if (new Set(eventIds).size !== eventIds.length)
    throw new Error("ablation event ids must be unique");
  const variants = {
    CFIE_BASE: eventIds,
    CFIE_NANSEN: eventIds,
    CFIE_COINGLASS: eventIds,
    CFIE_NANSEN_COINGLASS: eventIds,
  } as const;
  const equality = assertAblationPopulationEquality(variants);
  const returns = observations.map((item) => item.returnPct);
  const scoreFor = (variant: keyof typeof variants): number[] =>
    observations.map((item) => {
      const nansen = item.nansenScore ?? 0;
      const coinglass = item.coinglassScore ?? 0;
      if (variant === "CFIE_BASE") return item.baseScore;
      if (variant === "CFIE_NANSEN") return item.baseScore + nansen;
      if (variant === "CFIE_COINGLASS") return item.baseScore + coinglass;
      return item.baseScore + nansen + coinglass;
    });
  const results = Object.fromEntries(
    (Object.keys(variants) as (keyof typeof variants)[]).map((variant) => {
      const scores = scoreFor(variant);
      return [
        variant,
        {
          sampleSize: observations.length,
          scoreReturnCorrelation: correlation(scores, returns),
          nansenMissingCount: observations.filter((item) => item.nansenScore === null).length,
          coinglassMissingCount: observations.filter((item) => item.coinglassScore === null).length,
        },
      ];
    }),
  );
  const baseScores = scoreFor("CFIE_BASE");
  const nansenScores = scoreFor("CFIE_NANSEN");
  const baseCorrelation = correlation(baseScores, returns);
  const nansenCorrelation = correlation(nansenScores, returns);
  const observedDelta = (nansenCorrelation ?? 0) - (baseCorrelation ?? 0);
  const random = seededRandom(options.randomSeed ?? 20_261_006);
  const bootstrapIterations = options.bootstrapIterations ?? 500;
  const permutationIterations = options.permutationIterations ?? 500;
  if (
    !Number.isInteger(bootstrapIterations) ||
    bootstrapIterations < 100 ||
    bootstrapIterations > 10_000
  )
    throw new Error("bootstrap iterations must be between 100 and 10000");
  if (
    !Number.isInteger(permutationIterations) ||
    permutationIterations < 100 ||
    permutationIterations > 10_000
  )
    throw new Error("permutation iterations must be between 100 and 10000");
  const clusters = new Map<string, number[]>();
  observations.forEach((item, index) => {
    const key = item.eventTime ?? item.eventId;
    const members = clusters.get(key) ?? [];
    members.push(index);
    clusters.set(key, members);
  });
  const clusterValues = [...clusters.values()];
  const bootstrapDeltas: number[] = [];
  for (let iteration = 0; iteration < bootstrapIterations; iteration += 1) {
    const sample: number[] = [];
    let clusterIndex = 0;
    while (clusterIndex < clusterValues.length) {
      const selected = clusterValues.at(Math.floor(random() * clusterValues.length)) ?? [];
      sample.push(...selected);
      clusterIndex += 1;
    }
    const sampledReturns = sample.map((index) => returns.at(index) ?? 0);
    const base =
      correlation(
        sample.map((index) => baseScores.at(index) ?? 0),
        sampledReturns,
      ) ?? 0;
    const nansen =
      correlation(
        sample.map((index) => nansenScores.at(index) ?? 0),
        sampledReturns,
      ) ?? 0;
    bootstrapDeltas.push(nansen - base);
  }
  const rawNansen = observations.map((item) => item.nansenScore ?? 0);
  const uniqueNansenStates = new Set(rawNansen.map((value) => value.toPrecision(15))).size;
  let permutationExceedances = 0;
  for (let iteration = 0; iteration < permutationIterations; iteration += 1) {
    const shuffled = [...rawNansen];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const replacement = Math.floor(random() * (index + 1));
      const temporary = shuffled.at(index) ?? 0;
      const replacementValue = shuffled.at(replacement) ?? 0;
      shuffled.splice(index, 1, replacementValue);
      shuffled.splice(replacement, 1, temporary);
    }
    const permuted = baseScores.map((score, index) => score + (shuffled.at(index) ?? 0));
    const delta = (correlation(permuted, returns) ?? 0) - (baseCorrelation ?? 0);
    if (Math.abs(delta) >= Math.abs(observedDelta)) permutationExceedances += 1;
  }
  const permutationPValue = (permutationExceedances + 1) / (permutationIterations + 1);
  const extremeCount = Math.max(1, Math.ceil(observations.length * 0.01));
  const retained = observations
    .map((item, index) => ({ item, index }))
    .sort((left, right) => Math.abs(right.item.returnPct) - Math.abs(left.item.returnPct))
    .slice(extremeCount);
  const retainedReturns = retained.map(({ item }) => item.returnPct);
  const retainedBase = correlation(
    retained.map(({ index }) => baseScores.at(index) ?? 0),
    retainedReturns,
  );
  const retainedNansen = correlation(
    retained.map(({ index }) => nansenScores.at(index) ?? 0),
    retainedReturns,
  );
  const fieldValue = (
    item: EnrichmentAblationObservation,
    field: "regime" | "magnitudeBucket",
  ): string => (field === "regime" ? item.regime : (item.magnitudeBucket ?? "UNSPECIFIED"));
  const split = (field: "regime" | "magnitudeBucket") =>
    Object.fromEntries(
      [...new Set(observations.map((item) => fieldValue(item, field)))].sort().map((value) => {
        const members = observations
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => fieldValue(item, field) === value);
        const memberReturns = members.map(({ item }) => item.returnPct);
        const base = correlation(
          members.map(({ index }) => baseScores.at(index) ?? 0),
          memberReturns,
        );
        const nansen = correlation(
          members.map(({ index }) => nansenScores.at(index) ?? 0),
          memberReturns,
        );
        return [
          value,
          {
            sampleSize: members.length,
            baseCorrelation: base,
            nansenCorrelation: nansen,
            incrementalCorrelation: (nansen ?? 0) - (base ?? 0),
          },
        ];
      }),
    );
  const confidenceInterval = {
    lower: quantile(bootstrapDeltas, 0.025),
    upper: quantile(bootstrapDeltas, 0.975),
  };
  const candidateSignal =
    clusterValues.length >= 30 &&
    uniqueNansenStates >= 2 &&
    permutationPValue < 0.05 &&
    (confidenceInterval.lower ?? 0) * (confidenceInterval.upper ?? 0) > 0 &&
    Math.abs(observedDelta) >= 0.02;
  return {
    populationEquality: equality,
    results,
    controls: {
      normalSolMeanPct:
        observations.reduce((sum, item) => sum + item.normalSolReturnPct, 0) / observations.length,
      btcRelativeMeanPct: (() => {
        const available = observations.filter((item) => item.btcReturnPct !== null);
        return available.length === 0
          ? null
          : available.reduce((sum, item) => sum + item.returnPct - (item.btcReturnPct ?? 0), 0) /
              available.length;
      })(),
      btcAvailableCount: observations.filter((item) => item.btcReturnPct !== null).length,
      regimes: Object.fromEntries(
        [...new Set(observations.map((item) => item.regime))]
          .sort()
          .map((regime) => [regime, observations.filter((item) => item.regime === regime).length]),
      ),
    },
    incrementalValue: {
      observedCorrelationDelta: observedDelta,
      clusterBootstrap95Pct: confidenceInterval,
      bootstrapIterations,
      permutationPValue,
      benjaminiHochbergAdjustedPValue: permutationPValue,
      testedHypothesisCount: 1,
      permutationIterations,
      uniqueEventTimeClusters: clusterValues.length,
      uniqueNansenStates,
      extremeObservationRemoval: {
        removedCount: extremeCount,
        retainedCount: retained.length,
        incrementalCorrelation: (retainedNansen ?? 0) - (retainedBase ?? 0),
      },
      byRegime: split("regime"),
      byMagnitudeBucket: split("magnitudeBucket"),
      verdict:
        clusterValues.length < 30 || uniqueNansenStates < 2
          ? "INSUFFICIENT_TEMPORAL_VARIATION"
          : candidateSignal
            ? "CANDIDATE_SIGNAL_NOT_VALIDATED"
            : "ECONOMIC_USEFULNESS_NOT_DEMONSTRATED",
    },
    interpretation: "EXPLORATORY_NOT_TRADE_RECOMMENDATION" as const,
  };
}
