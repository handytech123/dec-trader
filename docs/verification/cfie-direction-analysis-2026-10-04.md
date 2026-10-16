# CFIE Direction Analysis Verification — 2026-10-04

## Outcome

CFIE now supports immutable, preregistered `DIRECTION` research runs. Each SOL capital event is
assigned one mutually exclusive, point-in-time cohort from its verified source class, destination
class, and (when available) verified invoking protocol.

Examples include `UNKNOWN→EXCHANGE` and `UNKNOWN→UNKNOWN|VIA:Jupiter V6`. Missing attribution
remains `UNKNOWN`; the analysis does not infer identities.

## Statistical controls

- Chronological development/holdout partitioning
- Deterministically seeded permutation tests
- Benjamini–Hochberg correction across development hypotheses
- No holdout-driven hypothesis selection
- Frozen dataset cutoff enforcement
- Minimum cohort and baseline sample sizes
- Immutable code and result hashes

## Verification

- A direction run was persisted under protocol `protocol_6544TAPR7FXC96R5BVW8582PZP`.
- Run ID: `research_run_4EY805APGSRP4WJYRE7G1HV2C5`
- The current frozen smoke dataset contains zero matured observations, so the correct result is
  `INSUFFICIENT_DATA` rather than a manufactured conclusion.
- No execution, wallet, signing, or order-placement capability was added.
