# CFIE v0.2 Phase 1 progress report

- Date: 2026-09-30
- Scope: Fixture-safe vertical slices completed after Phase 1.1

## Completed milestones

| Milestone                  | Status              | Evidence                                                                                                           |
| -------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1.1 Chain RPC collector    | Complete            | Finalized block polling, transactional checkpoints/gaps, immutable raw blocks, reconnect recovery                  |
| 1.2 Transfer normalizer    | Expanded core       | Native SOL, legacy SPL `transfer`, `transferChecked`, Token-2022 `transferCheckedWithFee`, and inner instructions  |
| 1.3 Exchange trade adapter | Core complete       | Coinbase match fixtures, aggressor-side normalization, sequence-gap detection, bounded reconnect/backoff lifecycle |
| 1.4 L2 order-book core     | Core complete       | Coinbase snapshots/updates, reconnect reset, durable snapshots, sorted levels, invariant rejection                 |
| 1.5 Replay capture         | Core complete       | Immutable raw blocks, deterministic IDs, and a unified future-masked capital/market timeline                       |
| 1.6 Entity-label store     | Foundation complete | Immutable point-in-time address lookup with confidence and attribution class                                       |
| 1.7 Exchange-flow detector | Foundation complete | Directional windows, baselines, z-scores, input event IDs                                                          |
| 1.8 Order-flow features    | Foundation complete | Aggressive trade imbalance with algorithm version and input IDs                                                    |
| 1.9 Event-study engine     | Existing foundation | Multi-horizon outcomes and anti-look-ahead tests predate CFIE v0.2                                                 |
| 1.10 Evidence JSON         | Core complete       | Deterministic packet with provenance, contradictions, quality, durable persistence, and validated retrieval        |

## Transfer-normalization boundary

The parser supports successful JSON-parsed System Program transfers and SPL Token legacy `transfer`,
`transferChecked`, and Token-2022 `transferCheckedWithFee` instructions in both top-level and inner
instruction lists. Legacy-transfer mint and decimals are resolved from transaction token balances;
unresolved assets are counted rather than guessed. Failed transactions are counted and excluded. USD
value remains `null` until a point-in-time valuation service supplies deterministic evidence.

## Durable integration completed

- Solana checkpoints, collection gaps, and immutable raw blocks share a transactional Postgres
  repository.
- Canonical market events, order-book snapshots, and evidence packets have durable write paths.
- Evidence packets have a validated retrieval API for downstream audit and explanation surfaces.
- Migrations `0012_market_events_and_evidence.sql` and `0013_raw_public_market_messages.sql` install
  append-only tables and immutability guards.
- Normalized Solana batches now persist their raw observation, raw block, assets, address entities,
  and capital events atomically and idempotently.
- Bounded Solana and Coinbase observation commands are disabled by default and require explicit
  opt-in, endpoints, and finite run limits.
- The first approved read-only pilot recorded 311 Solana blocks, 264,334 capital events, and 2,155
  Coinbase SOL-USD trades. Its storage benchmark is documented in the live pilot report.
- Integration tests exercise these paths against the repository's temporary Postgres harness.

## Remaining milestones

The remaining work depends on operational configuration or broader protocol coverage rather than a
missing core architecture:

- Improve capital-event persistence throughput before another sustained collection run. The
  compressed content-addressed raw-object store is complete for new writes.
- Add Coinbase REST backfill for exchange-side dropped matches.
- Add address lookup-table fixtures, additional Token-2022 extension cases, and explicit
  parser-version migration fixtures.
- Add explicit retention enforcement after retention windows are selected.

## Safety status

All additions are fixture-driven and read-only. No wallet, private key, signing, transaction
construction, transaction submission, exchange-order API, paid provider assumption, or autonomous
portfolio authority was added.
