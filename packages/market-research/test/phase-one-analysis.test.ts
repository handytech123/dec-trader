import { describe, expect, it } from "vitest";
import { analyzeTransferMagnitude, type TransferOutcomeObservation } from "../src/index.js";

function observations(effect = true): readonly TransferOutcomeObservation[] {
  return Array.from({ length: 260 }, (_, index) => {
    const extreme = index >= 40 && index % 10 === 0;
    return {
      eventId: `event_${String(index).padStart(26, "0")}`,
      eventAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      horizon: "1m",
      quantity: extreme ? 1_000 + index : 100 + (index % 7),
      returnPct: effect && extreme ? 2 : (index % 5) / 100,
    };
  });
}

describe("Phase 1 transfer-magnitude analysis", () => {
  it("uses prior observations for Z-scores and discovers a deterministic development effect", () => {
    const input = {
      observations: observations(),
      datasetCutoff: "2026-01-02T00:00:00.000Z",
      thresholds: [1, 2, 3, 4],
      minimumHistory: 30,
      minimumSampleSize: 10,
      holdoutFraction: 0.2,
      falseDiscoveryRate: 0.05,
      permutations: 199,
      seed: "42",
      openHoldout: true,
    } as const;
    const first = analyzeTransferMagnitude(input);
    const second = analyzeTransferMagnitude(input);
    expect(first).toEqual(second);
    expect(first.status).toBe("COMPLETE");
    expect(first.analyzableCount).toBe(230);
    expect(
      first.cells.some(
        (cell) => cell.partition === "DEVELOPMENT" && cell.significant && (cell.effectPct ?? 0) > 1,
      ),
    ).toBe(true);
    expect(first.cells.filter((cell) => cell.horizon === "1m")).toHaveLength(8);
    expect(first.falsification.control).toBe("REMOVE_LARGEST_FIVE");
    expect(Number.isInteger(first.falsification.testedFindingCount)).toBe(true);
    expect(Number.isInteger(first.falsification.survivingFindingCount)).toBe(true);
    expect(first.falsification.survivingFindingCount).toBeLessThanOrEqual(
      first.falsification.testedFindingCount,
    );
    expect(first.falsification.randomizedTimestampAlignment).toMatchObject({
      control: "RANDOMIZED_TIMESTAMP_ALIGNMENT",
      trialCount: 99,
      testedFindingCount: first.falsification.testedFindingCount,
    });
    expect(
      first.falsification.randomizedTimestampAlignment.survivingFindingCount,
    ).toBeLessThanOrEqual(first.falsification.testedFindingCount);
  });

  it("reports insufficient data instead of manufacturing a result", () => {
    const result = analyzeTransferMagnitude({
      observations: observations(false).slice(0, 40),
      datasetCutoff: "2026-01-02T00:00:00.000Z",
      thresholds: [1, 2, 3, 4],
      minimumSampleSize: 100,
      holdoutFraction: 0.2,
      falseDiscoveryRate: 0.05,
      permutations: 99,
      seed: "42",
    });
    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect(result.holdoutAccessed).toBe(false);
    expect(result.cells.every((cell) => cell.partition === "DEVELOPMENT")).toBe(true);
    expect(result.cells.every((cell) => !cell.significant)).toBe(true);
  });

  it("excludes observations after the frozen cutoff", () => {
    const result = analyzeTransferMagnitude({
      observations: observations().slice(0, 60),
      datasetCutoff: new Date(Date.UTC(2026, 0, 1, 0, 39)).toISOString(),
      thresholds: [1],
      minimumSampleSize: 10,
      holdoutFraction: 0.2,
      falseDiscoveryRate: 0.05,
      permutations: 99,
      seed: "42",
    });
    expect(result.observationCount).toBe(40);
    expect(result.analyzableCount).toBe(10);
  });
});
