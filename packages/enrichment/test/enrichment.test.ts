import { describe, expect, it, vi } from "vitest";
import {
  BoundedEnrichmentRuntime,
  assertAblationPopulationEquality,
  buildNansenChangeFeatures,
  evaluateEnrichmentAblation,
  finalizeEnrichmentObservation,
} from "../src/index.js";

const policy = {
  maximumRequestsPerMinute: 2,
  maximumRequestsPerDay: 3,
  maximumConcurrency: 1,
  cacheTtlMs: 1000,
  circuitFailureThreshold: 2,
  circuitResetMs: 5000,
};

describe("enrichment safety", () => {
  it("enforces point-in-time and retrospective separation", () => {
    expect(() =>
      finalizeEnrichmentObservation({
        observationId: "o",
        rawEnrichmentId: "r",
        provider: "nansen",
        observationType: "ENTITY_CLAIM",
        subject: "wallet",
        chain: "solana",
        scope: "EXTERNAL_DERIVED",
        metric: "label",
        value: "fund",
        retrievedAt: "2026-10-06T00:00:00.000Z",
        pointInTimeEligible: true,
        retrospectiveOnly: true,
        quality: "VALID",
        parserVersion: 1,
      }),
    ).toThrow(/retrospective/);
  });

  it("caches and coalesces duplicate requests", async () => {
    const runtime = new BoundedEnrichmentRuntime(policy);
    const operation = vi.fn(() => Promise.resolve({ value: 1 }));
    const [first, second] = await Promise.all([
      runtime.execute("same", operation, 10000),
      runtime.execute("same", operation, 10000),
    ]);
    expect(first).toEqual(second);
    await expect(runtime.execute("same", operation, 10500)).resolves.toEqual(first);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("requires equal A/B/C/D populations", () => {
    expect(
      assertAblationPopulationEquality({
        CFIE_BASE: ["a"],
        CFIE_NANSEN: ["a"],
        CFIE_COINGLASS: ["a"],
        CFIE_NANSEN_COINGLASS: ["a"],
      }).eligible,
    ).toBe(true);
    expect(
      assertAblationPopulationEquality({
        CFIE_BASE: ["a"],
        CFIE_NANSEN: ["b"],
        CFIE_COINGLASS: ["a"],
        CFIE_NANSEN_COINGLASS: ["a"],
      }).mismatches,
    ).toEqual(["CFIE_NANSEN"]);
  });

  it("derives leakage-safe changes, normalized holdings, ranks and anomaly scores", () => {
    const metrics = [
      "smart_money_holdings_value_usd",
      "smart_money_balance_24h_percent_change",
      "smart_money_holders_count",
      "smart_money_share_of_holdings_percent",
      "token_market_cap_usd",
    ];
    const values: Record<string, readonly number[]> = {
      SOL: [100, 5, 10, 1, 1000, 130, 6, 12, 1.2, 1000],
      JUP: [50, 1, 4, 0.5, 500, 55, 2, 5, 0.6, 500],
    };
    const observations = Object.entries(values).flatMap(([symbol, entries]) =>
      ["2026-10-06T00:00:00.000Z", "2026-10-06T01:00:00.000Z"].flatMap(
        (retrievedAt, snapshotIndex) =>
          metrics.map((metric, metricIndex) => ({
            observationId: `${symbol}-${String(snapshotIndex)}-${metric}`,
            subject: `${symbol}-mint`,
            symbol,
            retrievedAt,
            metric,
            value: entries[snapshotIndex * 5 + metricIndex] ?? 0,
          })),
      ),
    );
    const features = buildNansenChangeFeatures(observations);
    expect(features).toHaveLength(2);
    expect(features.find((item) => item.symbol === "SOL")).toMatchObject({
      holdingsValueDeltaUsd: 30,
      holdingsValueDeltaPct: 30,
      holdersCountDelta: 2,
      marketCapNormalizedHoldings: 0.13,
      crossSectionalValueRank: 1,
    });
  });

  it("evaluates identical ablation populations with explicit provider missingness", () => {
    const result = evaluateEnrichmentAblation([
      {
        eventId: "a",
        returnPct: 1,
        normalSolReturnPct: 0.2,
        btcReturnPct: 0.1,
        baseScore: 0.5,
        nansenScore: 1,
        coinglassScore: null,
        regime: "QUIET",
      },
      {
        eventId: "b",
        returnPct: -1,
        normalSolReturnPct: -0.2,
        btcReturnPct: -0.1,
        baseScore: -0.5,
        nansenScore: -1,
        coinglassScore: null,
        regime: "QUIET",
      },
    ]);
    expect(result.populationEquality.eligible).toBe(true);
    expect(result.results.CFIE_NANSEN).toMatchObject({
      sampleSize: 2,
      scoreReturnCorrelation: 1,
      coinglassMissingCount: 2,
    });
    expect(result.interpretation).toBe("EXPLORATORY_NOT_TRADE_RECOMMENDATION");
    expect(result.incrementalValue.verdict).toBe("INSUFFICIENT_TEMPORAL_VARIATION");
    expect(result.incrementalValue.uniqueEventTimeClusters).toBe(2);
  });

  it("keeps cluster bootstrap and permutation controls deterministic", () => {
    const observations = Array.from({ length: 40 }, (_, index) => ({
      eventId: `event-${String(index)}`,
      eventTime: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      returnPct: Math.sin(index / 3),
      normalSolReturnPct: 0,
      btcReturnPct: index % 3 === 0 ? null : Math.cos(index / 5),
      baseScore: Math.cos(index / 7),
      nansenScore: index % 2 === 0 ? 1 : -1,
      coinglassScore: null,
      regime: index % 2 === 0 ? "QUIET" : "VOLATILE",
      magnitudeBucket: `Q${String((index % 4) + 1)}`,
    }));
    const first = evaluateEnrichmentAblation(observations, {
      bootstrapIterations: 100,
      permutationIterations: 100,
      randomSeed: 7,
    });
    const second = evaluateEnrichmentAblation(observations, {
      bootstrapIterations: 100,
      permutationIterations: 100,
      randomSeed: 7,
    });
    expect(first.incrementalValue).toEqual(second.incrementalValue);
    expect(first.incrementalValue.uniqueEventTimeClusters).toBe(40);
    expect(first.incrementalValue.uniqueNansenStates).toBe(2);
    expect(first.controls.btcAvailableCount).toBe(26);
  });
});
