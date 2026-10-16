import { describe, expect, it } from "vitest";
import {
  clusterBootstrapMean,
  overlapDiagnostics,
  selectDeterministicNonOverlapping,
  type DependentObservation,
} from "../src/dependence.js";

const observation = (id: string, minute: number, episodeId = id): DependentObservation => ({
  observationId: id,
  episodeId,
  eventTime: `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`,
  horizonSeconds: 120,
  value: minute,
  regime: minute < 3 ? "CALM" : "VOLATILE",
});

describe("dependence diagnostics", () => {
  it("measures overlap and selects a deterministic non-overlapping sensitivity sample", () => {
    const input = [
      observation("a", 0, "episode_a"),
      observation("b", 1, "episode_a"),
      observation("c", 3),
    ];
    const diagnostics = overlapDiagnostics(input);
    expect(diagnostics).toMatchObject({
      totalObservations: 3,
      uniqueEpisodes: 2,
      overlappingObservations: 2,
      maximumOverlapDensity: 2,
      effectiveNonOverlappingSampleCount: 2,
    });
    expect(diagnostics.overlapPercentage).toBeCloseTo(200 / 3);
    expect(selectDeterministicNonOverlapping(input).map((item) => item.observationId)).toEqual([
      "a",
      "c",
    ]);
  });

  it("returns a deterministic cluster bootstrap with recorded assumptions", () => {
    const input = [
      observation("a", 0, "one"),
      observation("b", 1, "one"),
      observation("c", 3, "two"),
    ];
    const config = { clusterDefinition: "EPISODE" as const, seed: 42, iterations: 500 };
    expect(clusterBootstrapMean(input, config)).toEqual(clusterBootstrapMean(input, config));
    expect(clusterBootstrapMean(input, config)).toMatchObject({
      clusterCount: 2,
      seed: 42,
      iterations: 500,
    });
  });

  it("rejects pathological bootstrap inputs", () => {
    expect(() =>
      clusterBootstrapMean([], { clusterDefinition: "UTC_DAY", seed: 1, iterations: 100 }),
    ).toThrow();
    expect(() =>
      clusterBootstrapMean([observation("a", 0)], {
        clusterDefinition: "UTC_DAY",
        seed: 1,
        iterations: 99,
      }),
    ).toThrow();
  });
});
