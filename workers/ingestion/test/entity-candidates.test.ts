import { describe, expect, it } from "vitest";
import { classifyEntityBehavior } from "../src/entity-candidates.js";

describe("classifyEntityBehavior", () => {
  it("separates directional transfer behavior without asserting identity", () => {
    expect(
      classifyEntityBehavior({
        eventCount: 10,
        uniqueCounterpartyCount: 2,
        inflowEventCount: 7,
        outflowEventCount: 3,
      }),
    ).toBe("HEURISTIC_NET_RECEIVER");
    expect(
      classifyEntityBehavior({
        eventCount: 10,
        uniqueCounterpartyCount: 2,
        inflowEventCount: 3,
        outflowEventCount: 7,
      }),
    ).toBe("HEURISTIC_NET_SENDER");
  });

  it("distinguishes high-counterparty hubs from ordinary balanced activity", () => {
    expect(
      classifyEntityBehavior({
        eventCount: 100,
        uniqueCounterpartyCount: 30,
        inflowEventCount: 50,
        outflowEventCount: 50,
      }),
    ).toBe("HEURISTIC_HIGH_ACTIVITY_HUB");
    expect(
      classifyEntityBehavior({
        eventCount: 100,
        uniqueCounterpartyCount: 5,
        inflowEventCount: 50,
        outflowEventCount: 50,
      }),
    ).toBe("HEURISTIC_BALANCED_HUB");
  });

  it("handles one-way activity and rejects invalid quantities", () => {
    expect(
      classifyEntityBehavior({
        eventCount: 3,
        uniqueCounterpartyCount: 3,
        inflowEventCount: 0,
        outflowEventCount: 3,
      }),
    ).toBe("HEURISTIC_NET_SENDER");
    expect(() =>
      classifyEntityBehavior({
        eventCount: 1,
        uniqueCounterpartyCount: 1,
        inflowEventCount: -1,
        outflowEventCount: 0,
      }),
    ).toThrow("non-negative integers");
  });
});
