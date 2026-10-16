export interface PaperRiskLimits {
  readonly policyVersion: string;
  readonly maximumTradeNotionalUsd: number;
  readonly maximumAssetExposureUsd: number;
  readonly maximumPortfolioDrawdownPct: number;
  readonly maximumDailyLossUsd: number;
  readonly maximumMarketDataAgeSeconds: number;
}

export interface PaperRiskSnapshot {
  readonly evaluatedAt: string;
  readonly marketDataAgeSeconds: number;
  readonly portfolioDrawdownPct: number;
  readonly dailyPnlUsd: number;
  readonly currentAssetExposureUsd: number;
}

export interface PaperRiskIntent {
  readonly intentId: string;
  readonly styleId: string;
  readonly tradeNotionalUsd: number;
}

export interface PaperRiskDecision {
  readonly mode: "PAPER_ONLY";
  readonly policyVersion: string;
  readonly intentId: string;
  readonly styleId: string;
  readonly outcome: "APPROVED_FOR_PAPER_FILL" | "REJECTED";
  readonly checks: readonly {
    readonly check: string;
    readonly outcome: "PASS" | "FAIL";
    readonly actual: number;
    readonly threshold: number;
  }[];
}

const requireNonNegativeFinite = (value: number, label: string): void => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative`);
};

/** Independent paper-only pre-fill risk gate. It cannot build, sign, or transmit an order. */
export function evaluatePaperRisk(input: {
  readonly limits: PaperRiskLimits;
  readonly snapshot: PaperRiskSnapshot;
  readonly intent: PaperRiskIntent;
}): PaperRiskDecision {
  const { limits, snapshot, intent } = input;
  if (!limits.policyVersion || !intent.intentId || !intent.styleId)
    throw new Error("paper risk identity fields are required");
  if (!Number.isFinite(new Date(snapshot.evaluatedAt).getTime()))
    throw new Error("invalid risk evaluation time");
  requireNonNegativeFinite(limits.maximumTradeNotionalUsd, "maximum trade notional");
  requireNonNegativeFinite(limits.maximumAssetExposureUsd, "maximum asset exposure");
  requireNonNegativeFinite(limits.maximumPortfolioDrawdownPct, "maximum drawdown");
  requireNonNegativeFinite(limits.maximumDailyLossUsd, "maximum daily loss");
  requireNonNegativeFinite(limits.maximumMarketDataAgeSeconds, "maximum market data age");
  requireNonNegativeFinite(snapshot.marketDataAgeSeconds, "market data age");
  requireNonNegativeFinite(snapshot.portfolioDrawdownPct, "portfolio drawdown");
  requireNonNegativeFinite(snapshot.currentAssetExposureUsd, "current asset exposure");
  requireNonNegativeFinite(intent.tradeNotionalUsd, "trade notional");
  if (!Number.isFinite(snapshot.dailyPnlUsd)) throw new Error("daily PnL must be finite");

  const checks = [
    {
      check: "TRADE_NOTIONAL",
      outcome:
        intent.tradeNotionalUsd <= limits.maximumTradeNotionalUsd
          ? ("PASS" as const)
          : ("FAIL" as const),
      actual: intent.tradeNotionalUsd,
      threshold: limits.maximumTradeNotionalUsd,
    },
    {
      check: "POST_TRADE_ASSET_EXPOSURE",
      outcome:
        snapshot.currentAssetExposureUsd + intent.tradeNotionalUsd <= limits.maximumAssetExposureUsd
          ? ("PASS" as const)
          : ("FAIL" as const),
      actual: snapshot.currentAssetExposureUsd + intent.tradeNotionalUsd,
      threshold: limits.maximumAssetExposureUsd,
    },
    {
      check: "PORTFOLIO_DRAWDOWN",
      outcome:
        snapshot.portfolioDrawdownPct <= limits.maximumPortfolioDrawdownPct
          ? ("PASS" as const)
          : ("FAIL" as const),
      actual: snapshot.portfolioDrawdownPct,
      threshold: limits.maximumPortfolioDrawdownPct,
    },
    {
      check: "DAILY_LOSS",
      outcome:
        snapshot.dailyPnlUsd >= -limits.maximumDailyLossUsd ? ("PASS" as const) : ("FAIL" as const),
      actual: Math.max(0, -snapshot.dailyPnlUsd),
      threshold: limits.maximumDailyLossUsd,
    },
    {
      check: "MARKET_DATA_FRESHNESS",
      outcome:
        snapshot.marketDataAgeSeconds <= limits.maximumMarketDataAgeSeconds
          ? ("PASS" as const)
          : ("FAIL" as const),
      actual: snapshot.marketDataAgeSeconds,
      threshold: limits.maximumMarketDataAgeSeconds,
    },
  ];
  return {
    mode: "PAPER_ONLY",
    policyVersion: limits.policyVersion,
    intentId: intent.intentId,
    styleId: intent.styleId,
    outcome: checks.every((check) => check.outcome === "PASS")
      ? "APPROVED_FOR_PAPER_FILL"
      : "REJECTED",
    checks,
  };
}
