import { describe, expect, it } from "vitest";
import { evaluateEconomicMateriality, summarizeReturnEffect } from "../src/effect-size.js";

describe("effect size and economic materiality", () => {
  it("reports a return distribution rather than win rate alone", () => {
    expect(
      summarizeReturnEffect([-2, 1, 2, 3], [0, 0, 0, 0], {
        favorable: [1, 2, 3, 4],
        adverse: [-3, -1, -1, -1],
      }),
    ).toMatchObject({
      count: 4,
      mean: 1,
      median: 1.5,
      positiveFraction: 0.75,
      baselineMean: 0,
      differenceVersusBaseline: 1,
      maximumFavorableExcursion: 4,
      maximumAdverseExcursion: -3,
    });
  });

  it("labels statistically detectable but sub-threshold effects economically weak", () => {
    const policy = {
      version: 1,
      featureFamily: "TRANSFER_MAGNITUDE",
      horizonSeconds: 300,
      minimumAbsoluteEffect: 0.002,
      hypotheticalSpread: 0.0005,
      hypotheticalFee: 0.0005,
      hypotheticalSlippage: 0.0005,
      hypotheticalLatencyCost: 0.0005,
    };
    expect(evaluateEconomicMateriality(0.003, policy)).toMatchObject({
      netEffect: 0.001,
      decision: "ECONOMICALLY_WEAK",
    });
    expect(evaluateEconomicMateriality(-0.006, policy)).toMatchObject({
      netEffect: -0.004,
      decision: "ECONOMICALLY_MATERIAL",
    });
  });
});
