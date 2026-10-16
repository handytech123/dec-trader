import { describe, expect, it } from "vitest";
import {
  constrainedRandomBaseline,
  extremeObservationSensitivity,
  shiftedTimestampPlacebo,
} from "../src/falsification.js";

const item = (observationId: string, hour: string, value = 0) => ({
  observationId,
  assetId: "SOL",
  observedAt: `2026-01-01T${hour}:00:00.000Z`,
  regime: "QUIET",
  value,
});

describe("falsification controls", () => {
  it("constructs a deterministic baseline preserving asset, date, hour, regime, and count", () => {
    const input = {
      selected: [item("selected", "12")],
      candidates: [
        item("selected", "12"),
        item("b", "12"),
        item("a", "12"),
        item("wrong-hour", "13"),
      ],
      seed: "fixed-seed",
    };
    const first = constrainedRandomBaseline(input);
    expect(constrainedRandomBaseline(input)).toEqual(first);
    expect(first).toMatchObject({ selectedCount: 1, matchedCount: 1, unmatchedCount: 0 });
    expect(first.matches[0]?.baseline?.observedAt).toContain("T12:");
  });

  it("reports domination after removing the largest observations", () => {
    expect(
      extremeObservationSensitivity(
        [
          { observationId: "large", magnitude: 100, value: 10 },
          { observationId: "small-a", magnitude: 2, value: 0 },
          { observationId: "small-b", magnitude: 1, value: 0 },
        ],
        [1],
      ),
    ).toEqual({
      fullSampleMean: 10 / 3,
      results: [
        { removeLargestCount: 1, retainedCount: 2, mean: 0, removedObservationIds: ["large"] },
      ],
    });
  });

  it("creates explicit shifted-timestamp placebos", () => {
    expect(shiftedTimestampPlacebo([item("x", "12")], 3600)[0]?.placeboObservedAt).toBe(
      "2026-01-01T13:00:00.000Z",
    );
    expect(() => shiftedTimestampPlacebo([item("x", "12")], 0)).toThrow();
  });
});
