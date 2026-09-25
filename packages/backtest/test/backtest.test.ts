import { describe, expect, it } from "vitest";
import {
  calculateMetrics,
  createBacktestReport,
  simulatePaperFill,
  splitWalkForward,
  type PaperFillModel,
  type PaperOrder,
} from "../src/index.js";

const model: PaperFillModel = {
  modelVersion: "paper-v1",
  decisionToQuoteLatencyMs: 100,
  quoteToSubmitLatencyMs: 200,
  routeFeeBps: 20,
  networkFeeAtomic: "5",
  baseFailureBps: 100,
  stressMultiplier: "1",
};
const order: PaperOrder = {
  orderId: "order-1",
  inputAtomic: "1000",
  quotedOutputAtomic: "2000",
  availableLiquidityInputAtomic: "1000",
  priceImpactBps: 50,
  slippageBps: 30,
  decidedAt: "2026-01-01T00:00:00.000Z",
  quoteExpiresAt: "2026-01-01T00:00:01.000Z",
  deterministicFailureDrawBps: 500,
};

describe("cost-aware paper broker", () => {
  it("records net output, cost, latency, and model version", () => {
    expect(simulatePaperFill(order, model)).toEqual({
      status: "FILLED",
      orderId: "order-1",
      modelVersion: "paper-v1",
      inputAtomic: "1000",
      outputAtomic: "1980",
      executionCostOutputAtomic: "20",
      networkFeeAtomic: "5",
      totalLatencyMs: 300,
    });
  });

  it("models partial liquidity conservatively", () => {
    const fill = simulatePaperFill({ ...order, availableLiquidityInputAtomic: "400" }, model);
    expect(fill.status).toBe("PARTIAL");
    if (fill.status === "PARTIAL") expect(fill.inputAtomic).toBe("400");
  });

  it.each([
    [{ ...order, quoteExpiresAt: "2026-01-01T00:00:00.100Z" }, "QUOTE_EXPIRED"],
    [{ ...order, availableLiquidityInputAtomic: "0" }, "NO_LIQUIDITY"],
    [{ ...order, deterministicFailureDrawBps: 50 }, "SIMULATED_FAILURE"],
  ] as const)("rejects unavailable execution as %s", (candidate, reason) => {
    expect(simulatePaperFill(candidate, model)).toMatchObject({ status: "REJECTED", reason });
  });

  it("increases modeled cost under stress", () => {
    const base = simulatePaperFill(order, model);
    const stress = simulatePaperFill(order, { ...model, stressMultiplier: "2" });
    if (base.status === "FILLED" && stress.status === "FILLED") {
      expect(BigInt(stress.outputAtomic)).toBeLessThan(BigInt(base.outputAtomic));
    }
  });
});

describe("evaluation", () => {
  it("calculates after-cost metrics and drawdown", () => {
    expect(
      calculateMetrics([
        { netPnl: "10", exposure: "100" },
        { netPnl: "-4", exposure: "100" },
        { netPnl: "2", exposure: "50" },
      ]),
    ).toEqual({
      netPnl: "8",
      expectancy: "2.6666666666666666667",
      profitFactor: "3",
      winRate: "0.66666666666666666667",
      maximumDrawdown: "4",
      exposureAdjustedReturn: "0.032",
      tradeCount: 3,
    });
  });

  it("handles no-trade baseline without invented returns", () => {
    expect(calculateMetrics([])).toMatchObject({
      netPnl: "0",
      expectancy: "0",
      profitFactor: null,
      winRate: "0",
      exposureAdjustedReturn: null,
      tradeCount: 0,
    });
  });

  it("creates a content-addressed assumptions report", () => {
    const zero = calculateMetrics([]);
    const report = createBacktestReport({
      assumptions: {
        costsIncluded: ["impact", "slippage", "route", "network"],
        latencyModel: "fixed-v1",
        liquidityModel: "size-capped-v1",
        sampleSizeDeclaredBeforeRun: 100,
      },
      base: zero,
      stressed: zero,
      baseline: zero,
    });
    expect(report.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe("walk-forward evaluation", () => {
  it("creates strictly point-in-time windows", () => {
    const records = Array.from({ length: 8 }, (_, index) => ({
      sourceTime: `2026-01-0${String(index + 1)}T00:00:00.000Z`,
    }));
    const windows = splitWalkForward([...records].reverse(), 3, 2, 1);
    expect(windows).toHaveLength(3);
    for (const window of windows) {
      const trainEnd = window.train.at(-1)?.sourceTime;
      const validationStart = window.validation[0]?.sourceTime;
      const validationEnd = window.validation.at(-1)?.sourceTime;
      const testStart = window.test[0]?.sourceTime;
      expect(
        trainEnd !== undefined &&
          validationStart !== undefined &&
          validationEnd !== undefined &&
          testStart !== undefined &&
          trainEnd < validationStart &&
          validationEnd < testStart,
      ).toBe(true);
    }
  });

  it("rejects invalid windows and overlapping timestamps", () => {
    expect(() => splitWalkForward([], 0, 1, 1)).toThrow("positive integers");
    expect(() =>
      splitWalkForward(
        [{ sourceTime: "same" }, { sourceTime: "same" }, { sourceTime: "same" }],
        1,
        1,
        1,
      ),
    ).toThrow("leak");
  });
});
