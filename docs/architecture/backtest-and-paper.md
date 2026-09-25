# Phase 2 backtest and paper broker

The Phase 2 simulator is deterministic and deliberately conservative. A paper order records a
versioned fill model, decision-to-quote latency, quote-to-submit latency, quote expiry, available
liquidity, price impact, slippage, route fees, network fees, and a deterministic failure draw.

Execution costs denominated in output tokens remain separate from network fees; unlike quantities
are never added. Insufficient but nonzero liquidity produces a partial fill. Zero liquidity, expiry,
and simulated provider failure reject the fill. A stress multiplier increases variable costs without
changing historical observations.

Walk-forward windows enforce `train end < validation start` and `validation end < test start`.
Reports are content-addressed and invalid unless sample size and cost, latency, and liquidity
assumptions are disclosed. Metrics are computed from net trade results and include expectancy,
profit factor, win rate, maximum drawdown, and exposure-adjusted return. The no-trade baseline
reports zero rather than inventing exposure or returns.

Reference strategies are transparent validation instruments:

1. Momentum requires minimum return, volume acceleration, and liquidity.
2. Wallet-confirmed momentum adds an independent wallet-quality threshold.
3. A quorum ensemble combines proposals only; it has no money or execution capability.

These rules validate the laboratory. They are not profitability claims and are not live-eligible.
