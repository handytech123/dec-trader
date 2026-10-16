import { describe, expect, it } from "vitest";
import type { CapitalEvent, MarketEvent } from "@autonomous-trading-lab/capital-flow";
import { buildUnifiedTimeline } from "../src/index.js";

const hash = `sha256:${"a".repeat(64)}` as const;
const capital = {
  eventId: "event_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  eventTime: "2026-01-01T00:00:00.000Z",
  ingestTime: "2026-01-01T00:00:01.000Z",
  source: "fixture",
  chain: "solana",
  eventType: "TRANSFER",
  assetId: "asset_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  quantity: "1",
  usdValueAtEvent: null,
  fromEntityId: "entity_01ARZ3NDEKTSV4RRFFQ69G5FAX",
  confidence: 1,
  rawRef: hash,
  schemaVersion: "1",
} satisfies CapitalEvent;
const market = {
  eventId: "event_01ARZ3NDEKTSV4RRFFQ69G5FAY",
  eventTime: "2026-01-01T00:00:02.000Z",
  ingestTime: "2026-01-01T00:00:03.000Z",
  source: "fixture",
  venue: "coinbase",
  instrumentId: "instrument_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  eventType: "TRADE",
  price: "100",
  quantity: "1",
  rawRef: hash,
  schemaVersion: "1",
} satisfies MarketEvent;

describe("unified replay timeline", () => {
  it("masks future events and is deterministic", () => {
    const first = buildUnifiedTimeline([capital], [market], "2026-01-01T00:00:01.000Z");
    const second = buildUnifiedTimeline([capital], [market], "2026-01-01T00:00:01.000Z");
    expect(first.events.map((event) => event.domain)).toEqual(["CAPITAL"]);
    expect(first.replayHash).toBe(second.replayHash);
  });

  it("rejects an invalid replay cutoff", () => {
    expect(() => buildUnifiedTimeline([], [], "not-a-time")).toThrow(/valid timestamp/);
  });
});
