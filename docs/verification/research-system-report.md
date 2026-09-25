# Research and paper-trading system verification

Date: 2026-09-24

## Delivered

- Exact-mint Solana DEX discovery and append-only raw observation capture.
- Durable local PostgreSQL-compatible storage with checksummed migrations.
- Candidate, benchmark, and control universe roles.
- Versioned point-in-time features that exclude future observations.
- Versioned 1h, 6h, 24h, 7d, and 30d forward labels with MFE and MAE.
- Read-only Solana RPC mint inspection with conservative authority gates.
- Token-2022 TLV extension parsing and extension-specific block/review policy.
- Read-only $100 USDC buy/sell route assessment with round-trip loss and price-impact gates.
- Credential-free holder-count, top-holder concentration, verification, suspicious-token, and
  organic-activity evidence.
- Deterministic paper fills, cost and latency stress, metrics, and walk-forward splits.
- One-shot collection, safety, route, integrity, shadow, and data-health commands suitable for a
  future five-minute scheduler. No durable scheduler is installed by this repository.
- An append-only shadow-decision ledger and one-hour paper-position cycle with 100 bps costs on both
  entry and exit.
- A repository guard that rejects live wallet and transaction capabilities.

## Verified state

The full repository check passes 75 tests across 13 test files, workspace-boundary checks,
synthetic-fixture checks, eight migration checks, and the no-live-capability guard. A live research
run persisted 634 DEX observations across 105 pools and computed 628 immutable feature snapshots.
The initial 40-asset universe currently has 13 mint-safety passes, 9 manual reviews, and 18 blocks.
Round-trip route inspection assessed 26 candidate assets: 24 passed and 2 require review.
Market-integrity inspection assessed the same candidate universe: 13 passed, 9 require review, and 4
block. Six candidates currently pass all available research gates.

The universe is now segmented into AI, DeFi, DePIN, DEX, meme, RWA, and other-Solana cohorts using
current CoinGecko category membership. Category enrichment is best-effort: a rate-limited category
falls back to `other-solana` rather than inventing a classification. The research report includes
per-category eligible counts and a benchmark-based market regime that stays `UNKNOWN` until one hour
of benchmark history exists.

The shadow ledger currently contains 125 decisions: 124 no-trade decisions and one entry. The entry
has a corresponding $100 paper-only position with 100 bps modeled on both entry and exit. Decision
and position creation is atomic, and an integrity repair reconciles any historical interrupted write
before each cycle.

Open paper positions are marked to the latest observed price with modeled exit cost. The report also
shows current safety, route, and integrity gates separately from the entry-time decision; the
existing RAY paper position now shows that the stricter concentration policy would require review.

## Validity boundary

The software pipeline is operational, but no trading strategy is yet empirically validated. At the
time of this report the database contains zero matured forward outcomes because collection has only
just begun. Current five-minute changes are useful pipeline observations, not evidence of edge.

Validation requires rules and thresholds to be frozen before evaluation, sufficient independent
forward samples, time-ordered train/validation/test windows, realistic costs and failure rates,
category and market-regime breakdowns, and comparison against no-trade and simple baselines. Only
shadow signals and cost-aware paper positions are permitted before those requirements pass.

## Operational safety

Mint checks are intentionally conservative. Active freeze authority is blocked; active mint
authority requires review. Token-2022 metadata-only mints may pass; transfer hooks, permanent
delegates, pausable behavior, and non-transferability block, while fee, confidential, close,
interest-bearing, and scaled-amount extensions require review. Route checks expire after 45 minutes,
and a paper exit is not modeled without a fresh passing route.

The public Solana RPC rate-limits `getTokenLargestAccounts`; concentration is therefore sourced from
Jupiter's credential-free token audit instead. Raw top-holder percentage can include pools,
treasuries, and custody accounts, so 50–80% requires review rather than being called fraud; 80% or
an explicit suspicious-token flag blocks. Integrity evidence expires after 45 minutes. These checks
do not replace entity-adjusted concentration, liquidity-lock provenance, sanctions, or
jurisdictional review. No wallet creation, funding, private-key handling, signing, submission, or
live activation is present or authorized.
