import { describe, expect, it, vi } from "vitest";
import type { PersistedMarketReaction } from "../src/database.js";
import { matureMarketReactions } from "../src/market-reaction-worker.js";

const persisted = (eventId: string): PersistedMarketReaction =>
  ({ capitalEventId: eventId }) as PersistedMarketReaction;

describe("market-reaction maturation worker", () => {
  it("processes every bounded target/window and isolates event failures", async () => {
    const pendingMarketReactionEventIds = vi
      .fn()
      .mockResolvedValueOnce(["event-a", "event-b"])
      .mockResolvedValueOnce([]);
    const computeAndPersistMarketReaction = vi
      .fn()
      .mockResolvedValueOnce(persisted("event-a"))
      .mockRejectedValueOnce(new Error("fixture failure"));
    const result = await matureMarketReactions(
      { pendingMarketReactionEventIds, computeAndPersistMarketReaction },
      {
        targets: [{ venue: "coinbase-exchange", instrumentId: "instrument-sol-usd" }],
        windowsSeconds: [60, 300],
        asOf: "2026-01-01T00:05:00.000Z",
        maximumEventsPerWindow: 10,
        maximumSnapshotAgeSeconds: 60,
      },
    );
    expect(result).toMatchObject({ candidates: 2, completed: 1, failed: 1 });
    expect(result.windows).toEqual([
      {
        venue: "coinbase-exchange",
        instrumentId: "instrument-sol-usd",
        windowSeconds: 60,
        candidates: 2,
        completed: 1,
        failed: 1,
      },
      {
        venue: "coinbase-exchange",
        instrumentId: "instrument-sol-usd",
        windowSeconds: 300,
        candidates: 0,
        completed: 0,
        failed: 0,
      },
    ]);
    expect(result.failureSamples).toEqual([{ eventId: "event-b", error: "fixture failure" }]);
    expect(pendingMarketReactionEventIds).toHaveBeenCalledTimes(2);
  });

  it("rejects a mismatched persisted event without stopping later candidates", async () => {
    const result = await matureMarketReactions(
      {
        pendingMarketReactionEventIds: vi.fn().mockResolvedValue(["event-a", "event-b"]),
        computeAndPersistMarketReaction: vi
          .fn()
          .mockResolvedValueOnce(persisted("wrong-event"))
          .mockResolvedValueOnce(persisted("event-b")),
      },
      {
        targets: [{ venue: "coinbase-exchange", instrumentId: "instrument-sol-usd" }],
        windowsSeconds: [60],
        asOf: "2026-01-01T00:05:00.000Z",
        maximumEventsPerWindow: 10,
        maximumSnapshotAgeSeconds: 60,
      },
    );
    expect(result).toMatchObject({ candidates: 2, completed: 1, failed: 1 });
    expect(result.failureSamples[0]?.error).toMatch(/does not match/);
  });
});
