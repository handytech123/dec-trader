import { describe, expect, it } from "vitest";
import {
  classifyCandidateFragility,
  compareEpisodeInference,
  evaluateHypothesisBudget,
} from "../src/index.js";

describe("phase two research governance", () => {
  it("enforces bounded and visible hypothesis attempts", () => {
    expect(evaluateHypothesisBudget([{ family: "A" }, { family: "B" }])).toMatchObject({
      eligible: true,
      totalAttempts: 2,
    });
    expect(
      evaluateHypothesisBudget(Array.from({ length: 13 }, () => ({ family: "A" }))).violations,
    ).toContain("FAMILY_ATTEMPT_BUDGET_EXCEEDED:A");
  });

  it("compares deterministic samples with full episode inference", () => {
    const observations = Array.from({ length: 12 }, (_, index) => ({
      observationId: `event-${String(index)}`,
      episodeId: `episode-${String(Math.floor(index / 2))}`,
      eventTime: new Date(Date.UTC(2026, 0, 1 + Math.floor(index / 6), 0, index)).toISOString(),
      horizonSeconds: 60,
      value: index - 5,
      regime: index < 6 ? "QUIET" : "RISING",
    }));
    const result = compareEpisodeInference(observations, 7);
    expect(result).toMatchObject({ rawObservationCount: 12, episodeCount: 6, utcDayCount: 2 });
    expect(result.methods.map((item) => [item.method, item.observationCount])).toEqual([
      ["DETERMINISTIC_5000", 12],
      ["DETERMINISTIC_20000", 12],
      ["FULL_EPISODE", 6],
    ]);
    expect(result.methods.every((item) => item.episodeBootstrap.clusterCount > 0)).toBe(true);
  });

  it("classifies fragility without promoting a positive mean alone", () => {
    expect(
      classifyCandidateFragility({
        significant: true,
        economicallyMaterial: true,
        intervalExcludesZero: true,
        survivesLargestEventRemoval: true,
        survivesNonOverlap: true,
        walkForwardStable: true,
      }).classification,
    ).toBe("ROBUST");
    expect(
      classifyCandidateFragility({
        significant: true,
        economicallyMaterial: false,
        intervalExcludesZero: true,
        survivesLargestEventRemoval: true,
        survivesNonOverlap: true,
        walkForwardStable: true,
      }).classification,
    ).toBe("REJECTED");
  });
});
