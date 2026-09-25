import { describe, expect, it } from "vitest";
import { computeMarketFeaturesV1, type MarketPoint } from "../src/index.js";

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const point = (observedAt: string, price: string, suffix: string): MarketPoint => ({
  recordHash: hash(suffix),
  observedAt,
  price,
  volume24h: "1000",
  liquidityUsd: "50000",
  marketCap: "10000",
  fdv: "20000",
  buys24h: 60,
  sells24h: 40,
});

describe("point-in-time market features", () => {
  it("computes deterministic returns and ratios without future observations", () => {
    const result = computeMarketFeaturesV1(
      [
        point("2026-09-24T00:00:00.000Z", "100", "a"),
        point("2026-09-24T00:55:00.000Z", "105", "b"),
        point("2026-09-24T01:00:00.000Z", "110", "c"),
        point("2026-09-24T02:00:00.000Z", "999", "d"),
      ],
      "2026-09-24T01:00:00.000Z",
    );
    expect(result.values.return5mPct).toBe("4.7619047619047619048");
    expect(result.values.return1hPct).toBe("10");
    expect(result.values.buyShare24h).toBe("0.6");
    expect(result.values.turnover24h).toBe("0.1");
    expect(result.values.fdvToMarketCap).toBe("2");
    expect(result.values.observationCount).toBe(3);
  });

  it("returns null when the required lookback is unavailable", () => {
    const result = computeMarketFeaturesV1(
      [point("2026-09-24T01:00:00.000Z", "100", "a")],
      "2026-09-24T01:00:00.000Z",
    );
    expect(result.values.return5mPct).toBeNull();
    expect(result.values.return1hPct).toBeNull();
  });
});
