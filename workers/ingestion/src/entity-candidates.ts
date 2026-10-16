export type EntityBehaviorHeuristic =
  | "HEURISTIC_BALANCED_HUB"
  | "HEURISTIC_HIGH_ACTIVITY_HUB"
  | "HEURISTIC_NET_RECEIVER"
  | "HEURISTIC_NET_SENDER";

export interface EntityActivityTotals {
  readonly eventCount: number;
  readonly uniqueCounterpartyCount: number;
  readonly inflowEventCount: number;
  readonly outflowEventCount: number;
}

/** Describes observed transfer behavior only. It must never be used as an identity claim. */
export function classifyEntityBehavior(totals: EntityActivityTotals): EntityBehaviorHeuristic {
  const { inflowEventCount: inflow, outflowEventCount: outflow } = totals;
  if (!Number.isInteger(inflow) || !Number.isInteger(outflow) || inflow < 0 || outflow < 0)
    throw new Error("entity activity event counts must be non-negative integers");
  if (inflow === 0 && outflow > 0) return "HEURISTIC_NET_SENDER";
  if (outflow === 0 && inflow > 0) return "HEURISTIC_NET_RECEIVER";
  if (inflow >= outflow * 2) return "HEURISTIC_NET_RECEIVER";
  if (outflow >= inflow * 2) return "HEURISTIC_NET_SENDER";
  const counterpartyDensity =
    totals.eventCount === 0 ? 0 : totals.uniqueCounterpartyCount / totals.eventCount;
  return totals.uniqueCounterpartyCount >= 25 && counterpartyDensity >= 0.25
    ? "HEURISTIC_HIGH_ACTIVITY_HUB"
    : "HEURISTIC_BALANCED_HUB";
}
