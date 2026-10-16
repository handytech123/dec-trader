import { describe, expect, it } from "vitest";
import {
  referenceStyleLibrary,
  trainReferenceStyle,
  validateReferenceStyleWalkForward,
  type StyleTrainingObservation,
} from "../src/index.js";

const observation = (
  sourceTime: string,
  overrides: Partial<StyleTrainingObservation> = {},
): StyleTrainingObservation => ({
  sourceTime,
  regime: "RISING",
  regimeConfidence: 0.8,
  liquidityScore: 0.9,
  spreadBps: 10,
  deviationFromMeanBps: 40,
  forwardReturnBps: 30,
  protocolFlowZScore: 1,
  capitalFlowEpisodeCount: 1,
  ...overrides,
});

describe("reference paper style library", () => {
  it("keeps a profitable training result research-only without a separate walk-forward pass", () => {
    const trend = referenceStyleLibrary.find((style) => style.styleId === "LONG_TREND");
    if (!trend) throw new Error("missing trend definition");
    const trained = trainReferenceStyle({
      definition: trend,
      observations: [
        observation("2026-01-01T00:00:00.000Z"),
        observation("2026-01-02T00:00:00.000Z"),
      ],
      roundTripCostBps: 10,
      minimumSampleSize: 2,
      validationVerdict: "NOT_TESTED",
    });
    expect(trained).toMatchObject({
      tradeCount: 2,
      cumulativeNetReturnBps: 40,
      profile: {
        status: "RESEARCH_ONLY",
        grossExpectancyBps: 30,
        expectedCostBps: 10,
      },
    });
  });

  it("approves for paper routing only after an explicit pass and sufficient positive sample", () => {
    const trend = referenceStyleLibrary.find((style) => style.styleId === "LONG_TREND");
    if (!trend) throw new Error("missing trend definition");
    const trained = trainReferenceStyle({
      definition: trend,
      observations: [
        observation("2026-01-01T00:00:00.000Z", { forwardReturnBps: 40 }),
        observation("2026-01-02T00:00:00.000Z", { forwardReturnBps: 20 }),
      ],
      roundTripCostBps: 10,
      minimumSampleSize: 2,
      validationVerdict: "WALK_FORWARD_PASS",
    });
    expect(trained.profile.status).toBe("APPROVED_FOR_PAPER");
  });

  it("trains mean reversion only from below-mean observations in supported regimes", () => {
    const meanReversion = referenceStyleLibrary.find(
      (style) => style.styleId === "LONG_MEAN_REVERSION",
    );
    if (!meanReversion) throw new Error("missing mean-reversion definition");
    const trained = trainReferenceStyle({
      definition: meanReversion,
      observations: [
        observation("2026-01-01T00:00:00.000Z", {
          regime: "QUIET",
          deviationFromMeanBps: -70,
        }),
        observation("2026-01-02T00:00:00.000Z", {
          regime: "QUIET",
          deviationFromMeanBps: 70,
        }),
      ],
      roundTripCostBps: 10,
      minimumSampleSize: 1,
      validationVerdict: "WALK_FORWARD_PASS",
    });
    expect(trained.tradeCount).toBe(1);
    expect(trained.profile.status).toBe("APPROVED_FOR_PAPER");
  });

  it("requires positive out-of-sample folds before paper approval", () => {
    const trend = referenceStyleLibrary.find((style) => style.styleId === "LONG_TREND");
    if (!trend) throw new Error("missing trend definition");
    const observations = Array.from({ length: 12 }, (_, index) =>
      observation(new Date(Date.UTC(2026, 0, index + 1)).toISOString(), {
        forwardReturnBps: index < 4 ? 100 : 30,
      }),
    );
    expect(
      validateReferenceStyleWalkForward({
        definition: trend,
        observations,
        roundTripCostBps: 10,
        minimumDevelopmentObservations: 4,
        evaluationWindowObservations: 4,
        minimumEvaluationTrades: 8,
        minimumPositiveFoldFraction: 1,
      }),
    ).toMatchObject({
      verdict: "WALK_FORWARD_PASS",
      foldCount: 2,
      evaluationTradeCount: 8,
      positiveFoldFraction: 1,
      netExpectancyBps: 20,
    });
  });

  it("fails closed when CFIE flow confirmation is absent", () => {
    const trend = referenceStyleLibrary.find((style) => style.styleId === "LONG_TREND");
    if (!trend) throw new Error("missing trend definition");
    const result = trainReferenceStyle({
      definition: trend,
      observations: [observation("2026-01-01T00:00:00.000Z", { protocolFlowZScore: null })],
      roundTripCostBps: 10,
      minimumSampleSize: 1,
      validationVerdict: "WALK_FORWARD_PASS",
    });
    expect(result.tradeCount).toBe(0);
    expect(result.profile.status).toBe("RESEARCH_ONLY");
  });
});
