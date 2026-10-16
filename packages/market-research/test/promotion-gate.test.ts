import { describe, expect, it } from "vitest";
import { evaluateDevelopmentPromotionGate } from "../src/index.js";

const result = (overrides: Record<string, unknown> = {}) => ({
  status: "COMPLETE",
  holdoutAccessed: false,
  cells: [
    {
      partition: "DEVELOPMENT",
      significant: true,
      robustness: {
        status: "COMPLETE",
        overlapDependent: false,
        materiality: { decision: "ECONOMICALLY_MATERIAL" },
        clusterBootstrap: { byEpisode: { confidenceInterval: [0.1, 0.5] } },
      },
    },
  ],
  ...overrides,
});

describe("development promotion gate", () => {
  it("accepts only a sealed, robust, material development finding", () => {
    expect(evaluateDevelopmentPromotionGate(result())).toEqual({
      eligible: true,
      qualifyingFindingCount: 1,
      reasons: [],
    });
  });

  it("rejects incomplete, opened, or fragile findings", () => {
    expect(evaluateDevelopmentPromotionGate(result({ status: "INSUFFICIENT_DATA" })).eligible).toBe(
      false,
    );
    expect(evaluateDevelopmentPromotionGate(result({ holdoutAccessed: true })).reasons).toContain(
      "DEVELOPMENT_RESULT_NOT_SEALED",
    );
    expect(
      evaluateDevelopmentPromotionGate(
        result({
          cells: [
            {
              partition: "DEVELOPMENT",
              significant: true,
              robustness: {
                status: "COMPLETE",
                overlapDependent: true,
                materiality: { decision: "ECONOMICALLY_WEAK" },
                clusterBootstrap: { byEpisode: { confidenceInterval: [-0.1, 0.5] } },
              },
            },
          ],
        }),
      ).reasons,
    ).toContain("FINDINGS_FAILED_ROBUSTNESS_OR_MATERIALITY");
  });
});
