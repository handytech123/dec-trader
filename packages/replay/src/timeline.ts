import type { CapitalEvent, MarketEvent } from "@autonomous-trading-lab/capital-flow";
import { contentHash } from "@autonomous-trading-lab/domain";

export interface TimelineEvent {
  readonly domain: "CAPITAL" | "MARKET";
  readonly eventId: string;
  readonly eventTime: string;
  readonly inputHash: `sha256:${string}`;
}

export interface UnifiedTimeline {
  readonly asOf: string;
  readonly events: readonly TimelineEvent[];
  readonly replayHash: `sha256:${string}`;
}

export function buildUnifiedTimeline(
  capitalEvents: readonly CapitalEvent[],
  marketEvents: readonly MarketEvent[],
  asOf: string,
): UnifiedTimeline {
  const cutoff = new Date(asOf).getTime();
  if (!Number.isFinite(cutoff)) throw new Error("asOf must be a valid timestamp");
  const events = [
    ...capitalEvents.map((event) => ({ domain: "CAPITAL" as const, event })),
    ...marketEvents.map((event) => ({ domain: "MARKET" as const, event })),
  ]
    .filter(({ event }) => new Date(event.eventTime).getTime() <= cutoff)
    .map(({ domain, event }) => ({
      domain,
      eventId: event.eventId,
      eventTime: event.eventTime,
      inputHash: contentHash(event),
    }))
    .sort(
      (left, right) =>
        left.eventTime.localeCompare(right.eventTime) ||
        left.domain.localeCompare(right.domain) ||
        left.eventId.localeCompare(right.eventId),
    );
  const identity = { asOf, events };
  return { ...identity, replayHash: contentHash(identity) };
}
