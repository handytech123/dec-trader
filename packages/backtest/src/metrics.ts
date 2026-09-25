import { Decimal } from "decimal.js";

export interface ClosedTrade {
  readonly netPnl: string;
  readonly exposure: string;
}
export interface PerformanceMetrics {
  readonly netPnl: string;
  readonly expectancy: string;
  readonly profitFactor: string | null;
  readonly winRate: string;
  readonly maximumDrawdown: string;
  readonly exposureAdjustedReturn: string | null;
  readonly tradeCount: number;
}

export function calculateMetrics(trades: readonly ClosedTrade[]): PerformanceMetrics {
  let equity = new Decimal(0);
  let peak = new Decimal(0);
  let maximumDrawdown = new Decimal(0);
  let grossProfit = new Decimal(0);
  let grossLoss = new Decimal(0);
  let wins = 0;
  let exposure = new Decimal(0);
  for (const trade of trades) {
    const pnl = new Decimal(trade.netPnl);
    equity = equity.plus(pnl);
    exposure = exposure.plus(trade.exposure);
    if (pnl.greaterThan(0)) {
      grossProfit = grossProfit.plus(pnl);
      wins += 1;
    }
    if (pnl.lessThan(0)) grossLoss = grossLoss.plus(pnl.abs());
    peak = Decimal.max(peak, equity);
    maximumDrawdown = Decimal.max(maximumDrawdown, peak.minus(equity));
  }
  const count = trades.length;
  return {
    netPnl: equity.toString(),
    expectancy: count === 0 ? "0" : equity.div(count).toString(),
    profitFactor: grossLoss.isZero() ? null : grossProfit.div(grossLoss).toString(),
    winRate: count === 0 ? "0" : new Decimal(wins).div(count).toString(),
    maximumDrawdown: maximumDrawdown.toString(),
    exposureAdjustedReturn: exposure.isZero() ? null : equity.div(exposure).toString(),
    tradeCount: count,
  };
}
