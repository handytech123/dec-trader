import { describe, expect, it } from "vitest";
import { shouldRefreshEntityRollup } from "../src/derivation-policy.js";

describe("derivation rollup policy", () => {
  it("refreshes once when the owner-extraction backlog completes", () => {
    expect(
      shouldRefreshEntityRollup({
        completedCycles: 17,
        ownerExtractionRemaining: false,
        completionRollupPerformed: false,
      }),
    ).toBe(true);
    expect(
      shouldRefreshEntityRollup({
        completedCycles: 18,
        ownerExtractionRemaining: false,
        completionRollupPerformed: true,
      }),
    ).toBe(false);
  });

  it("retains the periodic safety refresh", () => {
    expect(
      shouldRefreshEntityRollup({
        completedCycles: 120,
        ownerExtractionRemaining: true,
        completionRollupPerformed: true,
      }),
    ).toBe(true);
  });
});
