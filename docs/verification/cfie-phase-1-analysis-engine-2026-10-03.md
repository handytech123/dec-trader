# CFIE Phase 1 analysis engine — 2026-10-03

## Outcome

The first preregistered CFIE research family is executable end to end. The implementation loads
immutable native-SOL capital-event outcomes, calculates transfer-size anomalies using only earlier
events, partitions observations chronologically, executes deterministic randomization tests,
controls the false-discovery rate, and stores the result as an immutable research run.

The first real run correctly returned `INSUFFICIENT_DATA`. The selected live smoke dataset contained
2,880 capital events and six reference-price snapshots, but no matured capital-event forward
outcomes. CFIE produced no significance claims.

## Statistical safeguards

- Point-in-time Z-scores use Welford running moments from prior events only.
- The first 30 observations per horizon are warm-up history and cannot enter a tested cohort.
- Thresholds are frozen at Z greater than 1, 2, 3, and 4.
- The latest 20% of analyzable observations are a chronological holdout.
- P-values use 999 deterministic label permutations.
- Development tests require at least 100 cohort observations and 100 baseline observations.
- Benjamini-Hochberg correction controls the registered false-discovery rate at 5%.
- Cells that cannot meet requirements retain null statistics and cannot become significant.
- All observations later than the registered dataset cutoff are excluded from this protocol run.

## Durable artifacts

- Protocol ID: `protocol_6544TAPR7FXC96R5BVW8582PZP`
- Run ID: `research_run_7K0E33DBXC1W4V5SA4FRAX9FHM`
- Analysis code hash: `sha256:747d1d0a52bedc6e85e25255d0bb6ec325c428321db7cdab3ab37c11156e8358`
- JSON result: `.atl-data/cfie-research-phase-1/transfer-magnitude-run.json`
- Result storage: immutable `research_analysis_runs` table

## Dataset inventory discovered during validation

| Dataset                        | Capital events | Reference snapshots | Capital outcomes |
| ------------------------------ | -------------: | ------------------: | ---------------: |
| Original 15-minute pilot       |        264,334 |                   0 |                0 |
| Helius combined validation     |          2,483 |                   0 |                0 |
| Forward-research service smoke |          2,880 |                   6 |                0 |

The earlier pilot predates the multivenue reference-price engine, so its events cannot be assigned
research-grade forward prices without importing matching point-in-time market history. The forward
service smoke was intentionally too short for even the one-minute outcomes to mature after prices
were collected.

## Interpretation

The research machinery is functioning, but economic usefulness remains unproven. The immediate
dependency is continuous, uninterrupted collection long enough to mature the registered horizons;
software must not substitute sparse data with guessed or look-ahead prices.

## Live collection follow-up

Two additional public-RPC runs recorded 35 and 58 blocks before rate limiting and produced 24,199
and 31,470 capital events respectively. The market side remained healthy and published 23 and 16
reference snapshots with no market-data incidents. Because the chain blocks remained earlier than
the first usable reference snapshots, the point-in-time join correctly emitted zero outcomes.

The collector now includes a serialized RPC request-start interval to prevent accidental bursts.
Even with pacing, the public endpoint returned HTTP 429 during the validation window. Sustained
collection should use the already selected dedicated RPC provider through `CFIE_SOLANA_RPC_URL`; the
key remains outside source control and generated artifacts.

The subsequent Helius validation succeeded with zero RPC failures and produced 90,480 capital
events, 28 reference snapshots, and 4,673 matured one-minute outcomes in the measured pilot. See
`cfie-helius-capacity-validation-2026-10-03.md` for the capacity and plan assessment.
