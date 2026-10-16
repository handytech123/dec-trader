import { describe, expect, it } from "vitest";
import { walkForwardEffect } from "../src/walk-forward.js";

const observations = Array.from({ length: 12 }, (_, index) => ({
  observationId: `o-${String(index)}`,
  observedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  candidate: index % 2 === 0,
  value: index % 2 === 0 ? 1 : 0,
}));

describe("walk-forward effect", () => {
  it("builds deterministic expanding windows without future observations in development", () => {
    const result = walkForwardEffect({
      observations,
      mode: "EXPANDING",
      minimumDevelopmentSize: 6,
      evaluationWindowSize: 2,
    });
    expect(result.foldCount).toBe(3);
    expect(result.stableDirectionFraction).toBe(1);
    for (const fold of result.folds)
      expect(String(fold.developmentEnd) < String(fold.evaluationStart)).toBe(true);
  });

  it("supports bounded rolling development and rejects invalid configurations", () => {
    const result = walkForwardEffect({
      observations,
      mode: "ROLLING",
      minimumDevelopmentSize: 4,
      rollingDevelopmentSize: 4,
      evaluationWindowSize: 2,
    });
    expect(result.folds.every((fold) => fold.developmentCount === 4)).toBe(true);
    expect(() =>
      walkForwardEffect({
        observations,
        mode: "ROLLING",
        minimumDevelopmentSize: 4,
        rollingDevelopmentSize: 3,
        evaluationWindowSize: 2,
      }),
    ).toThrow(/rolling/);
  });
});
