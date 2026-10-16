import { describe, expect, it } from "vitest";
import { classifyMarketRegime } from "../src/index.js";

const observations = (prices: readonly number[]) =>
  prices.map((price, index) => ({
    observedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    price,
    evidenceRef: `price-${String(index)}`,
  }));

describe("point-in-time market regime", () => {
  it("classifies directional and volatile windows deterministically", () => {
    const rising = classifyMarketRegime({
      observations: observations([100, 100.1, 100.2, 100.4]),
      asOf: "2026-01-01T00:03:00.000Z",
      windowSeconds: 3600,
      minimumSamples: 3,
      directionThresholdPct: 0.25,
      volatilityThresholdPct: 1,
    });
    expect(rising).toMatchObject({ state: "RISING", sampleSize: 4 });
    expect(
      classifyMarketRegime({
        observations: observations([100, 102, 99, 103]),
        asOf: "2026-01-01T00:03:00.000Z",
        windowSeconds: 3600,
        minimumSamples: 3,
        directionThresholdPct: 0.25,
        volatilityThresholdPct: 1,
      }).state,
    ).toBe("VOLATILE");
  });

  it("fails closed when history is insufficient", () => {
    expect(
      classifyMarketRegime({
        observations: observations([100, 101]),
        asOf: "2026-01-01T00:01:00.000Z",
        windowSeconds: 3600,
        minimumSamples: 3,
        directionThresholdPct: 0.25,
        volatilityThresholdPct: 1,
      }).state,
    ).toBe("INSUFFICIENT_DATA");
  });
});
