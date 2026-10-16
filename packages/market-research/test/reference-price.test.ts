import { describe, expect, it } from "vitest";
import {
  computeReferencePrice,
  type QuoteBasisObservation,
  type ReferencePriceConfig,
  type ReferencePriceObservation,
} from "../src/index.js";

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const asOf = "2026-10-03T00:00:10.000Z";
const config: ReferencePriceConfig = {
  baseAsset: "SOL",
  asOf,
  minimumVenues: 2,
  maximumAgeMs: 10_000,
  maximumBasisAgeMs: 60_000,
  maximumDeviationBps: 100,
  maximumSpreadBps: 100,
};
const basis: QuoteBasisObservation = {
  quoteAsset: "USDT",
  usdPerQuote: "0.999",
  observedAt: "2026-10-03T00:00:09.000Z",
  evidenceRef: hash("b"),
};
const observations: ReferencePriceObservation[] = [
  {
    venue: "coinbase-exchange",
    instrumentId: "SOL-USD",
    baseAsset: "SOL",
    quoteAsset: "USD",
    kind: "TRADE",
    price: "150",
    observedAt: "2026-10-03T00:00:09.000Z",
    evidenceRef: hash("a"),
  },
  {
    venue: "binance-us-spot",
    instrumentId: "SOLUSDT",
    baseAsset: "SOL",
    quoteAsset: "USDT",
    kind: "BOOK",
    price: "150.15",
    bid: "150.10",
    ask: "150.20",
    observedAt: "2026-10-03T00:00:09.500Z",
    evidenceRef: hash("c"),
  },
];
const coinbase = observations[0];
const binance = observations[1];
if (!coinbase || !binance) throw new Error("reference test fixtures are incomplete");

describe("multi-venue reference price", () => {
  it("publishes a deterministic USD estimate with explicit USDT basis evidence", () => {
    const result = computeReferencePrice(observations, basis, config);
    expect(result).toMatchObject({
      status: "PUBLISHED",
      baseAsset: "SOL",
      quoteAsset: "USD",
      price: "149.999925",
    });
    expect(result.confidenceLow).not.toBeNull();
    expect(result.confidenceHigh).not.toBeNull();
    expect(result.venueEstimates).toHaveLength(2);
    expect(result.evidenceRefs).toEqual([hash("a"), hash("b"), hash("c")]);
    expect(computeReferencePrice([...observations].reverse(), basis, config).contentHash).toBe(
      result.contentHash,
    );
  });

  it("withholds publication when the quote basis is unavailable", () => {
    const result = computeReferencePrice(observations, undefined, config);
    expect(result.status).toBe("WITHHELD");
    expect(result.price).toBeNull();
    expect(result.rejected).toContainEqual({
      evidenceRef: hash("c"),
      reason: "MISSING_OR_STALE_QUOTE_BASIS",
    });
    expect(result.reasons).toContain("INSUFFICIENT_INDEPENDENT_VENUES");
  });

  it("rejects stale, wide, future, and divergent observations", () => {
    const candidates: ReferencePriceObservation[] = [
      ...observations,
      {
        ...coinbase,
        venue: "stale",
        observedAt: "2026-10-02T23:00:00.000Z",
        evidenceRef: hash("d"),
      },
      {
        ...coinbase,
        venue: "future",
        observedAt: "2026-10-03T00:01:00.000Z",
        evidenceRef: hash("e"),
      },
      { ...coinbase, venue: "outlier", price: "200", evidenceRef: hash("f") },
      {
        ...binance,
        venue: "wide",
        bid: "140",
        ask: "160",
        evidenceRef: hash("1"),
      },
    ];
    const result = computeReferencePrice(candidates, basis, config);
    expect(result.status).toBe("PUBLISHED");
    expect(result.rejected.map((item) => item.reason)).toEqual(
      expect.arrayContaining([
        "STALE_OBSERVATION",
        "FUTURE_OBSERVATION",
        "VENUE_PRICE_OUTLIER",
        "SPREAD_TOO_WIDE",
      ]),
    );
  });
});
