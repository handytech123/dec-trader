import { describe, expect, it } from "vitest";
import { analyzeCandidateRobustness, type RobustnessObservation } from "../src/robustness.js";

const observation = (id: string, minute: number, value: number): RobustnessObservation => ({
  observationId: id,
  episodeId: minute < 2 ? "episode-a" : `episode-${id}`,
  observedAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
  horizonSeconds: 120,
  value,
  magnitude: Math.abs(value),
  regime: minute < 3 ? "QUIET" : "VOLATILE",
});

describe("candidate robustness", () => {
  it("combines overlap, non-overlap, clustered inference, effects, frictions, and extremes", () => {
    const input = {
      selected: [observation("a", 0, 2), observation("b", 1, 2), observation("c", 3, 1)],
      baseline: [observation("d", 5, 0), observation("e", 7, 0)],
      seed: 42,
      materialityPolicy: {
        version: 1,
        featureFamily: "TEST",
        horizonSeconds: 120,
        minimumAbsoluteEffect: 0.5,
        hypotheticalSpread: 0.05,
        hypotheticalFee: 0.05,
        hypotheticalSlippage: 0.05,
        hypotheticalLatencyCost: 0.05,
      },
    } as const;
    const result = analyzeCandidateRobustness(input);
    expect(result).toEqual(analyzeCandidateRobustness(input));
    expect(result).toMatchObject({
      status: "COMPLETE",
      overlap: { totalObservations: 3, uniqueEpisodes: 2, maximumOverlapDensity: 2 },
      materiality: { decision: "ECONOMICALLY_MATERIAL" },
      clusterBootstrap: { byEpisode: { seed: 42 }, byUtcDay: { seed: 42 } },
    });
  });

  it("fails closed without both candidate and baseline samples", () => {
    expect(
      analyzeCandidateRobustness({
        selected: [],
        baseline: [observation("a", 0, 0)],
        seed: 1,
        materialityPolicy: {
          version: 1,
          featureFamily: "TEST",
          horizonSeconds: 60,
          minimumAbsoluteEffect: 0,
          hypotheticalSpread: 0,
          hypotheticalFee: 0,
          hypotheticalSlippage: 0,
          hypotheticalLatencyCost: 0,
        },
      }),
    ).toEqual({ status: "INSUFFICIENT_DATA" });
  });
});
