import { describe, expect, it } from "vitest";
import { analyzeCategoricalFlows, type CategoricalFlowObservation } from "../src/index.js";

const observations = (): CategoricalFlowObservation[] =>
  Array.from({ length: 80 }, (_, index) => ({
    eventId: `event-${String(index).padStart(3, "0")}`,
    eventAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    horizon: "1m",
    cohort: index % 2 === 0 ? "UNKNOWN→EXCHANGE" : "EXCHANGE→UNKNOWN",
    returnPct: index % 2 === 0 ? -2 - index / 100 : 1 + index / 100,
  }));

describe("categorical capital-flow analysis", () => {
  it("uses chronological holdout partitions and development-only multiplicity correction", () => {
    const result = analyzeCategoricalFlows({
      observations: observations(),
      datasetCutoff: "2026-01-02T00:00:00.000Z",
      minimumSampleSize: 10,
      holdoutFraction: 0.2,
      falseDiscoveryRate: 0.05,
      permutations: 199,
      seed: "42",
      openHoldout: true,
    });
    expect(result.status).toBe("COMPLETE");
    expect(result.observationCount).toBe(80);
    const development = result.cells.find(
      (cell) => cell.cohort === "UNKNOWN→EXCHANGE" && cell.partition === "DEVELOPMENT",
    );
    const holdout = result.cells.find(
      (cell) => cell.cohort === "UNKNOWN→EXCHANGE" && cell.partition === "HOLDOUT",
    );
    expect(development?.sampleSize).toBe(32);
    expect(holdout?.sampleSize).toBe(8);
    expect(development?.effectPct).toBeLessThan(0);
    expect(development?.adjustedPValue).not.toBeNull();
    expect(development?.randomizedTimestampPValue).not.toBeNull();
    expect(result.randomizedTimestampTrials).toBe(99);
    expect(holdout?.adjustedPValue).toBeNull();
  });

  it("is deterministic and reports insufficient sparse data", () => {
    const input = {
      observations: observations().slice(0, 4),
      datasetCutoff: "2026-01-02T00:00:00.000Z",
      minimumSampleSize: 10,
      holdoutFraction: 0.2,
      falseDiscoveryRate: 0.05,
      permutations: 99,
      seed: "7",
    } as const;
    expect(analyzeCategoricalFlows(input)).toEqual(analyzeCategoricalFlows(input));
    expect(analyzeCategoricalFlows(input).status).toBe("INSUFFICIENT_DATA");
    expect(analyzeCategoricalFlows(input).holdoutAccessed).toBe(false);
    expect(
      analyzeCategoricalFlows(input).cells.every((cell) => cell.partition === "DEVELOPMENT"),
    ).toBe(true);
  });
});
