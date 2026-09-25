# Phase 2 verification report

- Date: 2026-09-25
- Status: Complete
- Scope: Cost-aware backtest and paper simulation

## Acceptance mapping

| Requirement                   | Evidence                                                 | Verification     |
| ----------------------------- | -------------------------------------------------------- | ---------------- |
| Cost-aware simulator          | Versioned paper model with impact/slippage/fees          | Fill tests       |
| Latency and expiry            | Two latency stages and quote-expiry rejection            | Boundary tests   |
| Liquidity/failure behavior    | Partial, zero-liquidity, and deterministic failure cases | Fill tests       |
| Metrics and baselines         | Net metrics plus honest no-trade baseline                | Metrics tests    |
| Walk-forward evaluation       | Strict train/validation/test ordering                    | Leakage tests    |
| Two reference strategies      | Momentum and wallet-confirmed momentum                   | Strategy tests   |
| Ensemble comparison primitive | Version-independent quorum proposal combiner             | Quorum tests     |
| Stressed costs                | Versioned stress multiplier lowers modeled output        | Sensitivity test |
| Assumption disclosure         | Content-addressed report requires declared assumptions   | Report tests     |
| No later-phase capability     | Prohibited-live-capability guard                         | Repository check |

## Required report disclosures

- Fill-model version and latency assumptions.
- Size/liquidity and partial-fill behavior.
- Impact, slippage, route/platform, and network costs by denomination.
- Failure and unavailable-route assumptions.
- Dataset boundaries, split method, seed, and declared sample size.
- Base, stressed, and baseline results reported net of modeled costs.

## Results

- Leakage tests enforce strictly ordered train, validation, and test windows.
- Deterministic paper fills cover latency, expiry, partial fills, unavailable liquidity, failure,
  and stressed transaction costs.
- Reports require explicit model, dataset, split, seed, cost, and failure assumptions and report net
  results against a no-trade baseline.
- Momentum, wallet-confirmed momentum, and quorum comparison tests pass.
- Repository regression suite: 75 tests passed across 13 files.
- Strict TypeScript build, formatting, linting, workspace boundaries, fixtures, eight migration
  checks, and the prohibited-live-capability guard passed.

These results validate the simulator mechanics and reporting contract, not profitability or a
tradable edge. Promotion remains subject to the Phase 3 shadow-run exit and later gates.
