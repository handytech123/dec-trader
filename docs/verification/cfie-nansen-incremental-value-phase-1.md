# CFIE Nansen Incremental-Value Evaluation

Generated: 2026-10-06

## Boundary

- Authority: `READ_ONLY_RESEARCH`
- Dataset: `DEVELOPMENT_ONLY`
- Holdout accessed: no
- Provider calls made by evaluation: 0
- CoinGlass: restricted and explicitly not evaluated
- Trading, wallet, signing, submission, and allocation authority: none

## Population

- Equal-population observations: 400
- Required minimum: 30
- Nansen feature availability: 400/400
- BTC-controlled observations: 101/400
- Unique event-time clusters: 7
- Unique point-in-time Nansen states: 1
- Market regime: 400 `QUIET`

## Result

- Baseline score/return correlation: -0.009956
- CFIE + Nansen score/return correlation: -0.009956
- Incremental correlation: effectively 0
- Cluster-bootstrap 95% interval: approximately 0 to 0
- Shuffled-feature permutation p-value: 1.0
- Extreme observations removed: 4
- Incremental correlation after removal: effectively 0
- Verdict: `INSUFFICIENT_TEMPORAL_VARIATION`

The cohort is point-in-time valid but spans only ten seconds and therefore shares one Nansen state.
It cannot measure whether changes in Nansen features improve prediction across time. This is not
evidence of economic usefulness and is not a definitive rejection of Nansen.

## Promotion gate

Do not promote or interpret this as a trading signal. Re-evaluate automatically as independently
timed capital-event clusters and additional Nansen states accumulate. A candidate result must have
at least 30 event-time clusters, at least two Nansen states, a multiple-testing-adjusted p-value
below 0.05, a cluster-bootstrap interval excluding zero, and an absolute incremental correlation of
at least 0.02. It must then survive unseen holdout data and costs before any economic claim is
allowed.

Machine-readable evidence: `artifacts/research/nansen-incremental-value-latest.json`
