import { describe, expect, it } from "vitest";
import {
  selectPaperStyle,
  type MarketStateSnapshot,
  type PaperStyleProfile,
  type StyleSelectorPolicy,
} from "../src/index.js";

const state: MarketStateSnapshot = {
  asOf: "2026-10-10T00:00:00.000Z",
  regime: "RISING",
  regimeConfidence: 0.82,
  liquidityScore: 0.9,
  spreadBps: 12,
};
const policy: StyleSelectorPolicy = {
  policyVersion: "paper-selector-v1",
  minimumDecisionScoreBps: 2,
  drawdownPenalty: 0.05,
};
const profile = (overrides: Partial<PaperStyleProfile> = {}): PaperStyleProfile => ({
  styleId: "trend",
  version: "trend-v1",
  status: "APPROVED_FOR_PAPER",
  supportedRegimes: ["RISING", "FALLING"],
  sampleSize: 250,
  minimumSampleSize: 100,
  grossExpectancyBps: 18,
  expectedCostBps: 5,
  maximumDrawdownBps: 100,
  minimumRegimeConfidence: 0.7,
  minimumLiquidityScore: 0.6,
  maximumSpreadBps: 25,
  ...overrides,
});

describe("paper style selector", () => {
  it("selects the eligible style with the highest deterministic risk-adjusted score", () => {
    const decision = selectPaperStyle({
      marketState: state,
      policy,
      profiles: [
        profile(),
        profile({
          styleId: "breakout",
          version: "breakout-v1",
          grossExpectancyBps: 24,
          maximumDrawdownBps: 80,
        }),
      ],
    });
    expect(decision).toMatchObject({
      mode: "PAPER_ONLY",
      decision: "SELECT_STYLE",
      selectedStyleId: "breakout",
      selectedStyleVersion: "breakout-v1",
      scoreBps: 15,
    });
  });

  it("defaults to no trade when evidence, regime, liquidity, or costs are inadequate", () => {
    const decision = selectPaperStyle({
      marketState: { ...state, regime: "QUIET", regimeConfidence: 0.4, liquidityScore: 0.2 },
      policy,
      profiles: [profile({ sampleSize: 20, grossExpectancyBps: 4, expectedCostBps: 8 })],
    });
    expect(decision).toMatchObject({
      mode: "PAPER_ONLY",
      decision: "NO_TRADE",
      selectedStyleId: null,
      reasons: ["NO_ELIGIBLE_STYLE"],
    });
    expect(decision.candidates[0]?.reasons).toEqual(
      expect.arrayContaining([
        "INSUFFICIENT_STYLE_SAMPLE",
        "REGIME_MISMATCH",
        "LOW_REGIME_CONFIDENCE",
        "LOW_LIQUIDITY",
        "INSUFFICIENT_NET_SCORE",
      ]),
    );
  });

  it("never selects research-only styles", () => {
    const decision = selectPaperStyle({
      marketState: state,
      policy,
      profiles: [profile({ status: "RESEARCH_ONLY", grossExpectancyBps: 100 })],
    });
    expect(decision.decision).toBe("NO_TRADE");
    expect(decision.candidates[0]?.reasons).toContain("STYLE_NOT_APPROVED_FOR_PAPER");
  });

  it("returns a no-style reason for an empty library", () => {
    expect(selectPaperStyle({ marketState: state, policy, profiles: [] })).toMatchObject({
      decision: "NO_TRADE",
      reasons: ["NO_STYLES_CONFIGURED"],
    });
  });
});
