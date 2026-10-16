# CFIE Research Phase 1 protocol freeze

Date: 2026-10-03

## Result

CFIE Research Phase 1 is preregistered in an immutable local research database. This milestone
freezes the hypotheses, forward horizons, falsification controls, minimum sample size, holdout
fraction, random seed, implementation hash, and dataset cutoff before outcome analysis.

- Protocol ID: `protocol_6544TAPR7FXC96R5BVW8582PZP`
- Dataset cutoff: `2026-10-03T08:04:14.0627744Z`
- Frozen at: `2026-10-03T08:04:37.833Z`
- Code hash: `sha256:83215a2af506e4c8aeb1422d5b6906bf88aefb3ca0282d8438e9cf28a77a5e99`
- Protocol content hash: `sha256:055d349bbdcaea6531471307668e7fbd1af93382a7571e1e95f7acb366b29463`
- Database: `.atl-data/cfie-research-phase-1/research-db`

## Registered research families

1. Transfer magnitude at point-in-time Z-score thresholds greater than 1, 2, 3, and 4.
2. Evidence-attributed exchange, DEX, bridge, and wallet flow direction.
3. Wallet-relative size, frequency, and dormancy anomalies.
4. Market reaction through imbalance, spread, depth, volatility, and volume.
5. Conditional combinations locked before holdout evaluation.
6. Falsification and control comparisons.

Forward horizons are 1 minute, 5 minutes, 15 minutes, 1 hour, 6 hours, and 24 hours.

## Mandatory falsification policy

Candidate findings must be tested against randomized timestamps, unconditional SOL behavior, BTC
market behavior, market regimes, removal of the five largest observations, a walk-forward holdout,
and trading costs. Multiple comparisons use Benjamini-Hochberg control at a 5% false discovery rate.
Each evaluated cell requires at least 100 observations, and 20% of eligible observations are
reserved for holdout evaluation.

## Leakage and identity protections

- Entity claims are available to a historical query only when `retrieved_at <= event time` and the
  claim's validity interval contains the event time.
- Claim and protocol identifiers reject conflicting content instead of silently accepting a
  collision.
- The protocol table rejects updates and deletes after publication.
- Reference prices remain point-in-time and forward outcomes remain immutable.

## Quality gates

At freeze time, the repository passed 156 tests across 35 files, 21 package-boundary checks, all 22
transactional migrations, formatting, linting, compilation, fixture validation, and the no-live-
capability safety guard.

## Interpretation

This artifact does not claim predictive or economic usefulness. It defines the rules by which that
claim may later be tested without silently changing hypotheses after observing results.
