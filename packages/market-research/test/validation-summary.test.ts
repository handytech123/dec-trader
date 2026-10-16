import { describe, expect, it } from "vitest";
import { summarizeResearchValidation } from "../src/index.js";

const cells = (holdout: Partial<Record<string, unknown>>) => [
  {
    horizon: "1m",
    threshold: 2,
    partition: "DEVELOPMENT",
    sampleSize: 200,
    baselineSize: 1000,
    effectPct: 0.4,
    pValue: 0.001,
    significant: true,
  },
  {
    horizon: "1m",
    threshold: 2,
    partition: "HOLDOUT",
    sampleSize: 120,
    baselineSize: 300,
    effectPct: 0.2,
    pValue: 0.01,
    significant: false,
    ...holdout,
  },
];

describe("research validation summary", () => {
  it("distinguishes underpowered, failed, and replicated holdouts", () => {
    expect(
      summarizeResearchValidation({
        status: "COMPLETE",
        minimumSampleSize: 100,
        cells: cells({ sampleSize: 20 }),
      }).verdict,
    ).toBe("HOLDOUT_UNDERPOWERED");
    expect(
      summarizeResearchValidation({
        status: "COMPLETE",
        minimumSampleSize: 100,
        cells: cells({ effectPct: -0.2 }),
      }).verdict,
    ).toBe("FAILED_HOLDOUT");
    expect(
      summarizeResearchValidation({
        status: "COMPLETE",
        minimumSampleSize: 100,
        cells: cells({}),
      }),
    ).toMatchObject({ verdict: "HOLDOUT_REPLICATED", replicatedHoldoutCount: 1 });
  });

  it("does not manufacture a conclusion from incomplete research", () => {
    expect(
      summarizeResearchValidation({
        status: "INSUFFICIENT_DATA",
        minimumSampleSize: 100,
        cells: [],
      }),
    ).toMatchObject({ verdict: "INSUFFICIENT_DATA", developmentFindingCount: 0 });
    expect(
      summarizeResearchValidation({
        status: "COMPLETE",
        minimumSampleSize: 100,
        cells: [
          ...cells({}).map((cell) => ({ ...cell, significant: false })),
          {
            horizon: "5m",
            threshold: 2,
            partition: "DEVELOPMENT",
            sampleSize: 0,
            baselineSize: 0,
            pValue: null,
            significant: false,
          },
        ],
      }).verdict,
    ).toBe("PARTIAL_NO_DEVELOPMENT_FINDING");
  });
});
