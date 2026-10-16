import { Decimal } from "decimal.js";
import { contentHash } from "@autonomous-trading-lab/domain";
import type { CapitalEvent } from "./schemas.js";

export interface ExchangeFlowQuery {
  readonly assetId: string;
  readonly exchangeEntityIds: readonly string[];
  readonly asOf: string;
  readonly windowSeconds: number;
  readonly baselineWindows: number;
  readonly minimumBaselineWindows: number;
}

export interface ExchangeFlowAnomaly {
  readonly featureVersion: 1;
  readonly asOf: string;
  readonly windowSeconds: number;
  readonly direction: "INFLOW" | "OUTFLOW";
  readonly currentUsdValue: string;
  readonly baselineMeanUsdValue: string | null;
  readonly baselineStandardDeviationUsdValue: string | null;
  readonly zScore: string | null;
  readonly baselineWindowCount: number;
  readonly evidenceEventIds: readonly string[];
  readonly contentHash: `sha256:${string}`;
}

function flowDirection(
  event: CapitalEvent,
  exchangeEntityIds: ReadonlySet<string>,
): "INFLOW" | "OUTFLOW" | undefined {
  const fromExchange = event.fromEntityId ? exchangeEntityIds.has(event.fromEntityId) : false;
  const toExchange = event.toEntityId ? exchangeEntityIds.has(event.toEntityId) : false;
  if (toExchange && !fromExchange) return "INFLOW";
  if (fromExchange && !toExchange) return "OUTFLOW";
  return undefined;
}

function summarize(
  events: readonly CapitalEvent[],
  query: ExchangeFlowQuery,
  direction: "INFLOW" | "OUTFLOW",
): ExchangeFlowAnomaly {
  if (!Number.isInteger(query.windowSeconds) || query.windowSeconds <= 0)
    throw new Error("windowSeconds must be a positive integer");
  if (!Number.isInteger(query.baselineWindows) || query.baselineWindows <= 0)
    throw new Error("baselineWindows must be a positive integer");
  if (
    !Number.isInteger(query.minimumBaselineWindows) ||
    query.minimumBaselineWindows < 2 ||
    query.minimumBaselineWindows > query.baselineWindows
  )
    throw new Error("minimumBaselineWindows must be between 2 and baselineWindows");

  const asOfMs = new Date(query.asOf).getTime();
  if (!Number.isFinite(asOfMs)) throw new Error("asOf must be a valid timestamp");
  const windowMs = query.windowSeconds * 1000;
  const exchangeIds = new Set(query.exchangeEntityIds);
  if (exchangeIds.size === 0) throw new Error("at least one exchange entity is required");

  const totals = new Map<number, Decimal>();
  for (let index = 0; index <= query.baselineWindows; index += 1) totals.set(index, new Decimal(0));
  const evidence: string[] = [];
  const oldestIncluded = asOfMs - windowMs * (query.baselineWindows + 1);

  for (const event of events) {
    const eventMs = new Date(event.eventTime).getTime();
    if (
      event.assetId !== query.assetId ||
      eventMs > asOfMs ||
      eventMs <= oldestIncluded ||
      event.usdValueAtEvent === null ||
      flowDirection(event, exchangeIds) !== direction
    )
      continue;
    const bucket = Math.floor((asOfMs - eventMs) / windowMs);
    const total = totals.get(bucket);
    if (total === undefined) continue;
    totals.set(bucket, total.plus(event.usdValueAtEvent));
    if (bucket === 0) evidence.push(event.eventId);
  }

  const current = totals.get(0) ?? new Decimal(0);
  const baseline = Array.from(
    { length: query.baselineWindows },
    (_, index) => totals.get(index + 1) ?? new Decimal(0),
  );
  let mean: Decimal | null = null;
  let standardDeviation: Decimal | null = null;
  let zScore: Decimal | null = null;
  if (baseline.length >= query.minimumBaselineWindows) {
    const baselineMean = Decimal.sum(...baseline).div(baseline.length);
    mean = baselineMean;
    const variance = Decimal.sum(...baseline.map((value) => value.minus(baselineMean).pow(2))).div(
      baseline.length,
    );
    standardDeviation = variance.sqrt();
    if (!standardDeviation.isZero()) zScore = current.minus(mean).div(standardDeviation);
  }

  const identity = {
    featureVersion: 1 as const,
    asOf: query.asOf,
    windowSeconds: query.windowSeconds,
    direction,
    currentUsdValue: current.toString(),
    baselineMeanUsdValue: mean?.toString() ?? null,
    baselineStandardDeviationUsdValue: standardDeviation?.toString() ?? null,
    zScore: zScore?.toString() ?? null,
    baselineWindowCount: baseline.length,
    evidenceEventIds: evidence.sort(),
  };
  return { ...identity, contentHash: contentHash(identity) };
}

export function computeExchangeFlowAnomalies(
  events: readonly CapitalEvent[],
  query: ExchangeFlowQuery,
): readonly [ExchangeFlowAnomaly, ExchangeFlowAnomaly] {
  return [summarize(events, query, "INFLOW"), summarize(events, query, "OUTFLOW")];
}
