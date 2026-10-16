import { describe, expect, it } from "vitest";
import {
  applyPaperFill,
  evaluatePaperRisk,
  simulatePaperFill,
  type PaperFillModel,
  type PaperOrder,
  type PaperPortfolio,
} from "../src/index.js";

const limits = {
  policyVersion: "paper-risk-v1",
  maximumTradeNotionalUsd: 100,
  maximumAssetExposureUsd: 250,
  maximumPortfolioDrawdownPct: 5,
  maximumDailyLossUsd: 50,
  maximumMarketDataAgeSeconds: 15,
};
const snapshot = {
  evaluatedAt: "2026-10-10T00:00:00.000Z",
  marketDataAgeSeconds: 2,
  portfolioDrawdownPct: 1,
  dailyPnlUsd: -5,
  currentAssetExposureUsd: 50,
};

describe("paper-only risk and ledger loop", () => {
  it("approves a bounded paper intent and applies its conservative fill", () => {
    const risk = evaluatePaperRisk({
      limits,
      snapshot,
      intent: { intentId: "paper-intent-1", styleId: "trend", tradeNotionalUsd: 75 },
    });
    expect(risk.outcome).toBe("APPROVED_FOR_PAPER_FILL");
    const model: PaperFillModel = {
      modelVersion: "paper-v1",
      decisionToQuoteLatencyMs: 100,
      quoteToSubmitLatencyMs: 200,
      routeFeeBps: 20,
      networkFeeAtomic: "5000",
      baseFailureBps: 0,
      stressMultiplier: "1",
    };
    const order: PaperOrder = {
      orderId: "paper-order-1",
      inputAtomic: "75000000",
      quotedOutputAtomic: "500000000",
      availableLiquidityInputAtomic: "75000000",
      priceImpactBps: 25,
      slippageBps: 25,
      decidedAt: "2026-10-10T00:00:00.000Z",
      quoteExpiresAt: "2026-10-10T00:00:01.000Z",
      deterministicFailureDrawBps: 500,
    };
    const fill = simulatePaperFill(order, model);
    const portfolio: PaperPortfolio = {
      portfolioId: "paper-portfolio-1",
      version: 0,
      balancesAtomic: { USDC: "100000000", SOL: "0" },
    };
    const result = applyPaperFill({
      portfolio,
      inputAsset: "USDC",
      outputAsset: "SOL",
      fill,
    });
    expect(result).toMatchObject({
      status: "APPLIED",
      portfolio: {
        version: 1,
        balancesAtomic: { SOL: "496500000", USDC: "25000000" },
      },
      entry: { mode: "PAPER_ONLY", orderId: "paper-order-1" },
    });
  });

  it("rejects stale, oversized, overexposed, or loss-breaching paper intents", () => {
    const risk = evaluatePaperRisk({
      limits,
      snapshot: {
        ...snapshot,
        marketDataAgeSeconds: 30,
        portfolioDrawdownPct: 8,
        dailyPnlUsd: -75,
        currentAssetExposureUsd: 240,
      },
      intent: { intentId: "paper-intent-2", styleId: "trend", tradeNotionalUsd: 125 },
    });
    expect(risk.outcome).toBe("REJECTED");
    expect(risk.checks.filter((check) => check.outcome === "FAIL")).toHaveLength(5);
  });

  it("does not mutate a portfolio for rejected fills or insufficient paper balance", () => {
    const portfolio: PaperPortfolio = {
      portfolioId: "paper-portfolio-1",
      version: 2,
      balancesAtomic: { USDC: "10" },
    };
    expect(
      applyPaperFill({
        portfolio,
        inputAsset: "USDC",
        outputAsset: "SOL",
        fill: {
          status: "REJECTED",
          orderId: "paper-order-rejected",
          modelVersion: "paper-v1",
          reason: "NO_LIQUIDITY",
        },
      }),
    ).toEqual({ status: "NOT_APPLIED", reason: "FILL_REJECTED", portfolio });
    expect(
      applyPaperFill({
        portfolio,
        inputAsset: "USDC",
        outputAsset: "SOL",
        fill: {
          status: "FILLED",
          orderId: "paper-order-too-large",
          modelVersion: "paper-v1",
          inputAtomic: "11",
          outputAtomic: "1",
          executionCostOutputAtomic: "0",
          networkFeeAtomic: "0",
          totalLatencyMs: 1,
        },
      }),
    ).toEqual({ status: "NOT_APPLIED", reason: "INSUFFICIENT_PAPER_BALANCE", portfolio });
  });
});
