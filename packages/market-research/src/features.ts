import { Decimal } from "decimal.js";
import { contentHash } from "@autonomous-trading-lab/domain";

export interface MarketPoint {
  readonly recordHash: `sha256:${string}`;
  readonly observedAt: string;
  readonly price: string;
  readonly volume24h: string | null;
  readonly liquidityUsd: string;
  readonly marketCap: string | null;
  readonly fdv: string | null;
  readonly buys24h: number | null;
  readonly sells24h: number | null;
}

export interface MarketFeaturesV1 {
  readonly featureVersion: 1;
  readonly return5mPct: string | null;
  readonly return1hPct: string | null;
  readonly return6hPct: string | null;
  readonly return24hPct: string | null;
  readonly liquidityChange1hPct: string | null;
  readonly reportedVolume24hChange1hPct: string | null;
  readonly buyShare24h: string | null;
  readonly turnover24h: string | null;
  readonly fdvToMarketCap: string | null;
  readonly observationCount: number;
  readonly historySpanSeconds: string;
}

const percentageChange = (current: string, previous: string): string | null => {
  const denominator = new Decimal(previous);
  if (denominator.isZero()) return null;
  return new Decimal(current).minus(denominator).div(denominator).mul(100).toString();
};

function pointNear(
  ordered: readonly MarketPoint[],
  currentTimestamp: number,
  lookbackMs: number,
  toleranceMs: number,
): MarketPoint | undefined {
  const target = currentTimestamp - lookbackMs;
  let best: MarketPoint | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of ordered) {
    const timestamp = new Date(point.observedAt).getTime();
    // A current observation may fall inside the tolerance window for short
    // lookbacks. It is not history and must never be allowed to self-match.
    if (timestamp >= currentTimestamp) continue;
    const distance = Math.abs(timestamp - target);
    if (distance <= toleranceMs && distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

export function computeMarketFeaturesV1(
  observations: readonly MarketPoint[],
  asOf: string,
  toleranceMs = 7 * 60_000,
): { readonly values: MarketFeaturesV1; readonly contentHash: `sha256:${string}` } {
  const asOfTimestamp = new Date(asOf).getTime();
  const ordered = observations
    .filter((point) => new Date(point.observedAt).getTime() <= asOfTimestamp)
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
  const current = ordered.at(-1);
  if (!current) throw new Error("at least one point-in-time observation is required");
  const previous5m = pointNear(ordered, asOfTimestamp, 5 * 60_000, toleranceMs);
  const previous1h = pointNear(ordered, asOfTimestamp, 60 * 60_000, toleranceMs);
  const previous6h = pointNear(ordered, asOfTimestamp, 6 * 60 * 60_000, toleranceMs);
  const previous24h = pointNear(ordered, asOfTimestamp, 24 * 60 * 60_000, toleranceMs);
  const totalTransactions = (current.buys24h ?? 0) + (current.sells24h ?? 0);
  const first = ordered[0];
  if (!first) throw new Error("feature history unexpectedly empty");
  const ratio = (numerator: string | null, denominator: string | null): string | null => {
    if (numerator === null || denominator === null || new Decimal(denominator).isZero())
      return null;
    return new Decimal(numerator).div(denominator).toString();
  };
  const values: MarketFeaturesV1 = {
    featureVersion: 1,
    return5mPct: previous5m ? percentageChange(current.price, previous5m.price) : null,
    return1hPct: previous1h ? percentageChange(current.price, previous1h.price) : null,
    return6hPct: previous6h ? percentageChange(current.price, previous6h.price) : null,
    return24hPct: previous24h ? percentageChange(current.price, previous24h.price) : null,
    liquidityChange1hPct: previous1h
      ? percentageChange(current.liquidityUsd, previous1h.liquidityUsd)
      : null,
    reportedVolume24hChange1hPct:
      previous1h?.volume24h && current.volume24h
        ? percentageChange(current.volume24h, previous1h.volume24h)
        : null,
    buyShare24h:
      totalTransactions === 0
        ? null
        : new Decimal(current.buys24h ?? 0).div(totalTransactions).toString(),
    turnover24h: ratio(current.volume24h, current.marketCap),
    fdvToMarketCap: ratio(current.fdv, current.marketCap),
    observationCount: ordered.length,
    historySpanSeconds: new Decimal(asOfTimestamp)
      .minus(new Date(first.observedAt).getTime())
      .div(1000)
      .toString(),
  };
  return { values, contentHash: contentHash(values) };
}
