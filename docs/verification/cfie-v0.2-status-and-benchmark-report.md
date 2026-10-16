# CFIE v0.2 implementation status and benchmark report

- Report date: 2026-09-30
- Reviewed branch: `codex/phase-2-backtest-paper`
- Reviewed revision: `45bea3e` plus the current uncommitted CFIE implementation
- Specification authority: CFIE Engineering Specification v0.2
- Current operating boundary: read-only research system; live observation is explicit opt-in

## Executive assessment

The Capital Flow Intelligence Engine now has a working, verified research foundation spanning
canonical schemas, read-only Solana collection, transfer normalization, public Coinbase market-data
decoding, sequence-safe order-book state, deterministic replay, flow features, evidence assembly,
and durable storage for raw chain data, market events, books, and evidence packets.

The repository passes every defined quality gate. After durable capital-event persistence and the
bounded observation runtimes were added, three consecutive full `pnpm check` runs averaged **14.113
seconds**, all runs exited successfully, and the total spread was **0.326 seconds**. The test suite
contains **130 passing tests in 28 files**. Measured V8 coverage is **89.37% statements, 81.88%
branches, 89.43% functions, and 92.25% lines**.

The implementation is not yet a live production collector. The missing work is concentrated in
deployed endpoint operation, retention load validation, additional protocol edge cases, and
production-scale performance validation. No wallet, signing, transaction submission, exchange order,
or autonomous portfolio authority has been added.

## Delivery status by milestone

| Milestone                       | Status              | Delivered and verified                                                                                                                      | Remaining boundary                                                  |
| ------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 0.1 Workspace and quality gates | Complete            | Strict TypeScript pnpm monorepo; format, lint, build, test, boundary, fixture, migration, coverage, and no-live checks                      | None for the research foundation                                    |
| 0.2 Canonical IDs and schemas   | Complete            | Deterministic identifiers, atomic quantities, canonical event and provider schemas, runtime validation                                      | Extend only when new provider data requires it                      |
| 0.3 Provider contracts          | Complete            | Vendor-neutral capability descriptors and read-only chain/market interfaces                                                                 | Add concrete transports behind existing interfaces                  |
| 0.4 Provenance and immutability | Complete            | Content hashes, raw references, parser versions, immutable records, and controlled audited raw retention                                    | Validate retention cadence under sustained load                     |
| 0.5 Relational foundation       | Complete            | Eighteen ordered PostgreSQL migrations with transactional verification, immutability guards, queue, retention audit, and feed incidents     | Benchmark against deployed PostgreSQL                               |
| 1.1 Solana collection           | Complete            | Finalized HTTP polling, bounded batches, checkpoints, explicit gaps, retries, recovery, immutable raw blocks                                | Configure a real endpoint and service schedule                      |
| 1.2 Transfer normalization      | Expanded core       | Native SOL, legacy SPL `transfer`, `transferChecked`, Token-2022 `transferCheckedWithFee`, inner instructions, failed-transaction rejection | ALT fixtures, more Token-2022 extensions, parser migration fixtures |
| 1.3 Coinbase trades             | Core complete       | Public match decoding, concrete WSS transport, public-channel subscription, sequence-gap detection, bounded reconnect/backoff               | Approved live run and REST gap backfill                             |
| 1.4 L2 order book               | Core complete       | Snapshot rebuild, absolute-size deltas, contiguous sequence enforcement, crossed-book rejection, reconnect reset, durable snapshots         | Soak test using a live public feed                                  |
| 1.5 Replay                      | Core complete       | Deterministic replay cursor and unified capital/market timeline with future masking and stable hashes                                       | Large recorded-session performance benchmark                        |
| 1.6 Entity labels               | Foundation complete | Immutable point-in-time labels, confidence, attribution class, and evidence references                                                      | Operational label source and review workflow                        |
| 1.7 Exchange flow               | Foundation complete | Directional windows, point-in-time baselines, z-scores, deterministic evidence IDs                                                          | Calibrate thresholds on historical data                             |
| 1.8 Order-flow features         | Foundation complete | Aggressive trade imbalance with algorithm version and input IDs                                                                             | Add broader depth and liquidity features                            |
| 1.9 Event studies               | Existing foundation | Multi-horizon outcomes, cost-aware backtesting, walk-forward windows, anti-look-ahead checks                                                | Calibrate against production-quality history                        |
| 1.10 Evidence packets           | Core complete       | Deterministic packets, provenance, features, contradictions, quality, human-review action, persistence, retrieval                           | Add user-facing review/API surface                                  |

## Implemented architecture

### Collection and normalization

- The Solana provider exposes only finalized block reads and validates official JSON-RPC-shaped
  responses.
- The collector advances a checkpoint only after every available block in its bounded batch is
  accepted by the sink.
- Missing or unavailable slots become explicit gap records instead of disappearing silently.
- A disconnect leaves the checkpoint unchanged, allowing deterministic replay on recovery.
- Transfer normalization processes top-level and inner instructions and does not invent mint or
  decimal information when legacy token-balance evidence is absent.
- Every normalized transfer carries deterministic identity and raw provenance; point-in-time USD
  value remains null until a valuation service provides auditable evidence.

### Market data and order flow

- Coinbase fixture decoding follows public Exchange message shapes for matches, L2 snapshots, and L2
  updates.
- Match-side semantics are converted from maker side to canonical aggressor side.
- Trade sequence discontinuities are surfaced as gaps.
- Order books require a snapshot before deltas, enforce contiguous sequence, treat updates as
  absolute size, delete zero-size levels, and reject invalid or crossed books.
- The connection lifecycle has bounded exponential backoff, a finite retry budget, cancellation,
  connection cleanup, and a reconnect callback that invalidates stale local state.

### Replay, features, and evidence

- Replay identity is content-addressed and deterministic for identical inputs.
- Unified replay sorts capital and market events deterministically and excludes events after the
  requested `asOf` cutoff.
- Exchange-flow features use directional windows, historical baselines, z-scores, and exact input
  event IDs.
- Order-flow features preserve the algorithm version and the trades used to calculate imbalance.
- Evidence packets connect the conclusion back to raw provenance, derived features, conflicting
  evidence, data quality, and a human-review action.

### Persistence

- Solana raw observations, raw blocks, assets, address entities, and capital events commit
  atomically; checkpoints and collection gaps use the same repository.
- Public Coinbase WebSocket frames are stored immutably before trade or book derivation.
- Canonical market events, order-book snapshots, and evidence packets have durable write paths.
- Stored evidence packets are parsed and validated again when retrieved.
- Database migrations install immutable entities, relationships, capital-flow schema, enrichment
  claims, chain collection state, market events, books, and evidence storage.
- Local integration tests execute migrations and repository operations using the temporary
  PostgreSQL-compatible PGlite harness.

## Verification results

### Current quality gate

| Check                  |          Result | Verified scope                                           |
| ---------------------- | --------------: | -------------------------------------------------------- |
| Formatting             |            Pass | All matched repository files conform to Prettier         |
| Static analysis        |            Pass | ESLint completed with zero warnings allowed              |
| TypeScript build       |            Pass | Project-reference build completed successfully           |
| Automated tests        | 130 of 130 pass | 28 test files; no failed or skipped tests reported       |
| Workspace boundaries   |            Pass | 19 packages validated                                    |
| Fixture integrity      |            Pass | 4 synthetic fixture files validated                      |
| Migration verification |            Pass | 18 transactional PostgreSQL migrations validated         |
| Live-capability guard  |            Pass | No prohibited Phase 0 live execution capability detected |
| Diff whitespace check  |            Pass | `git diff --check` produced no errors                    |

### Coverage benchmark

| Metric     | Covered | Total |       Rate |
| ---------- | ------: | ----: | ---------: |
| Statements |     597 |   668 | **89.37%** |
| Branches   |     339 |   414 | **81.88%** |
| Functions  |     110 |   123 | **89.43%** |
| Lines      |     560 |   607 | **92.25%** |

The refreshed coverage run reported **7.56 seconds** of runner duration; its parallel phase totals
were 4.76 seconds transforming modules, 11.00 seconds importing, 20.01 seconds executing tests, and
4 milliseconds for test environments. Parallel phase totals are not additive wall time.

Areas with the most useful remaining coverage work are identifier error branches, connection
lifecycle failure variants, replay branch variants, and report-generation edge cases. The core
Solana normalizer reached **98.87% line coverage**; the Solana provider group reached **95.71%**;
capital-flow reached **95.00%**.

## Timing benchmarks

### Method

Measurements were taken locally in PowerShell using `System.Diagnostics.Stopwatch`. Each regular
stage and the complete quality gate were run three consecutive times against the same checkout.
These are warm local developer-workstation measurements, not cold CI timings. Commands were run
serially; each process had its output redirected during stage measurements to avoid
console-rendering noise.

Benchmark environment:

| Component        | Value                                                 |
| ---------------- | ----------------------------------------------------- |
| Operating system | Microsoft Windows NT 10.0.26200.0                     |
| Processor        | AMD Ryzen 9 7900X, 12 cores and 24 logical processors |
| Memory           | 47.2 GiB reported physical memory                     |
| Node.js          | v22.17.1                                              |
| pnpm             | 11.5.1                                                |
| PowerShell       | 7.6.5                                                 |

### Complete quality gate

|      Run |    Wall time | Result            |
| -------: | -----------: | ----------------- |
|        1 |     14.289 s | Pass              |
|        2 |     13.963 s | Pass              |
|        3 |     14.087 s | Pass              |
| **Mean** | **14.113 s** | **3 of 3 passed** |

Observed minimum was **13.963 seconds**, maximum was **14.289 seconds**, and the max-minus-min
spread was **0.326 seconds**, or approximately **2.31% of the mean**.

### Individual stage baseline

The stage-level measurements below predate the bounded observation additions and are retained as the
last isolated baseline. The complete quality-gate table above is the current end-to-end measurement.

| Stage                        |   Run 1 |   Run 2 |   Run 3 |        Mean |   Range | Result |
| ---------------------------- | ------: | ------: | ------: | ----------: | ------: | ------ |
| Format check                 | 1.596 s | 1.516 s | 1.520 s | **1.544 s** | 0.080 s | Pass   |
| ESLint                       | 4.792 s | 4.815 s | 4.756 s | **4.788 s** | 0.059 s | Pass   |
| Incremental TypeScript build | 0.532 s | 0.511 s | 0.509 s | **0.517 s** | 0.023 s | Pass   |
| Test suite                   | 3.488 s | 3.517 s | 3.481 s | **3.495 s** | 0.036 s | Pass   |
| Workspace boundaries         | 0.444 s | 0.423 s | 0.436 s | **0.434 s** | 0.021 s | Pass   |
| Fixture verification         | 0.435 s | 0.424 s | 0.417 s | **0.425 s** | 0.018 s | Pass   |
| Migration verification       | 0.425 s | 0.421 s | 0.416 s | **0.421 s** | 0.009 s | Pass   |
| No-live safety scan          | 0.505 s | 0.489 s | 0.490 s | **0.495 s** | 0.016 s | Pass   |

The isolated baseline stage means sum to approximately 12.119 seconds. The build result is
explicitly an incremental benchmark because the TypeScript build cache was present. A clean build
benchmark has not been claimed.

## Test-scope detail

The 117 tests cover the following behavior groups:

- canonical serialization, deterministic hashing, and forbidden authority fields;
- exact atomic-quantity properties and noncanonical input rejection;
- provider contract stability, health degradation, timeout, rate-limit, and malformed responses;
- PostgreSQL migration ordering, transactional execution, idempotence, and published-record
  immutability;
- finalized Solana block ranges, skipped slots, unavailable blocks, disconnect recovery, and HTTPS
  transport policy;
- native SOL, SPL, Token-2022, top-level, and inner transfer normalization;
- Coinbase trades, aggressor-side conversion, dropped messages, L2 snapshot/update processing, and
  reconnect behavior;
- sequence-safe order books, invalid levels, crossed books, and trade imbalance;
- future-data exclusion, deterministic replay, input mutation, and strategy-version mismatch;
- entity-label point-in-time lookup, exchange-flow z-scores, evidence connectivity, and evidence
  retrieval;
- token authority and Token-2022 extension screening;
- route sellability, market-integrity review outcomes, paper-broker costs, partial liquidity,
  drawdown, and walk-forward evaluation.

## Implementation inventory

The repository currently contains **96 TypeScript files with 7,959 lines**, **18 SQL migration files
with 563 lines**, and **46 Markdown files with 1,772 lines**, excluding dependencies, remote
attachments, and the separate `crypto-eval-review` directory.

The seven new CFIE-focused packages contain the following directly measured implementation and test
inventory:

| Package                    | Source files | Source lines | Test files | Test lines |
| -------------------------- | -----------: | -----------: | ---------: | ---------: |
| `capital-flow`             |            4 |          318 |          2 |        218 |
| `coinbase-market-provider` |            2 |          172 |          2 |        123 |
| `evidence`                 |            1 |           56 |          1 |         84 |
| `order-flow`               |            1 |          108 |          1 |         69 |
| `provider-sdk`             |            1 |          118 |          0 |          0 |
| `solana-chain-provider`    |            3 |          238 |          2 |        166 |
| `solana-normalization`     |            2 |          221 |          1 |         96 |
| **Subtotal**               |       **14** |    **1,231** |      **9** |    **756** |

Provider SDK behavior is exercised through the provider testkit and consuming-package tests rather
than a package-local test file. The subtotal excludes integration changes in replay and ingestion,
including the 40-line unified timeline, its 43-line test, and the 115-line CFIE persistence
integration test.

## Database evolution

| Migration range | Purpose                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| 0001–0004       | Data foundation, research collection, forward outcomes, market features |
| 0005–0008       | Token safety, shadow/paper records, route sellability, market integrity |
| 0009            | Capital-flow entities, relationships, and canonical events              |
| 0010            | Immutable enrichment claims and point-in-time evidence                  |
| 0011            | Chain checkpoints, gaps, and immutable raw blocks                       |
| 0012            | Canonical market events, order-book snapshots, and evidence packets     |
| 0013            | Immutable raw public-market WebSocket messages                          |
| 0014            | Lossless base64 raw payloads beside queryable JSONB projections         |
| 0015            | Compressed content-addressed raw objects and metadata references        |

All fifteen migrations pass the repository's transactional migration verifier. This confirms schema
compatibility with the local test harness; it does not establish production PostgreSQL throughput,
storage growth, index selectivity, replication behavior, or recovery time.

## Safety and authority boundary

The current system can read recorded or public market and chain data, normalize it, compute research
features, replay it, and produce review evidence. It cannot sign or submit a blockchain transaction,
place an exchange order, access a wallet, or autonomously allocate capital. Tests also reject domain
objects containing forbidden live-authority fields and the repository-wide no-live guard passes.

This boundary is intentional and should remain in force until live execution receives a separate
specification, threat model, authorization design, and explicit approval.

## Known gaps and benchmark limitations

The following measurements have **not** been performed and should not be inferred from the local
results above:

- sustained live Solana RPC throughput, rate-limit behavior, or finalization latency;
- Coinbase WebSocket uptime, heartbeat behavior, message-loss rate, or reconnect recovery under a
  real public feed;
- production PostgreSQL inserts per second, query latency, storage growth, failover, or restore
  time;
- multi-hour memory stability, backpressure, and disk-pressure behavior;
- replay throughput on million-event or multi-gigabyte recordings;
- alert precision, recall, false-positive rate, or economic usefulness on historical ground truth;
- cold install, cold TypeScript build, or clean CI runner duration.

The local database harness provides strong functional evidence but is not a substitute for deployed
PostgreSQL load testing. The fixture set is deliberately small and deterministic, so the current
timings measure developer feedback speed rather than production data capacity.

## Recommended next work

### Priority 1: durable capital-event path completed

Normalized capital events, raw observations, raw blocks, asset records, and address-entity registry
records now commit in one transaction. Tests cover idempotent replay, foreign-key integrity,
identity-collision rejection, canonical decimal retrieval, and rollback after a partial-write error.

### Priority 2: bounded live read-only collector and normalization queue implemented

Concrete Coinbase WebSocket transport, public-channel subscription, raw-frame persistence,
normalized trade/book persistence, and bounded Solana and Coinbase observation commands are
implemented. The combined pilot now commits each raw Solana block and its normalization job
atomically, checkpoints capture independently, and normalizes concurrently with leases, bounded
parallelism, queue-depth backpressure, bounded retries, poison-job termination, idempotent replay,
and a final drain. Commands remain disabled by default and require explicit endpoints and finite
limits. Controlled seven-day raw retention and operational queue/audit reporting are implemented.
Coinbase gaps and reconnects are durable incidents. Bounded backfill, reconciliation, and a concrete
public REST adapter are implemented; live pagination and recovery behavior still require a bounded
validation run.

### Priority 3: expand protocol fixtures

Add Solana address lookup-table transactions, more Token-2022 extension combinations, malformed
balance mappings, and parser-version migration fixtures. Add exchange fixtures for duplicate,
out-of-order, stale, and reconnect-boundary messages.

### Priority 4: run capacity and research-quality benchmarks

Use a recorded data corpus to measure events per second, p50/p95/p99 processing latency, peak
memory, database batch throughput, replay determinism at scale, and recovery after injected
failures. Then evaluate detector precision and stability using point-in-time labeled historical
periods.

## Inputs required before live integration

No additional input is required to continue fixture and persistence work. Before enabling live
read-only collection, the project owner should approve:

1. Solana RPC and Coinbase endpoint choices.
2. Product and asset allowlists.
3. Request, reconnect, batch, and storage limits.
4. Raw-data and derived-data retention windows.
5. Deployment target and secret-management mechanism.
6. Operational alerting and acceptable data-gap thresholds.

Those decisions affect operating cost and reliability, but they do not block the current offline
research foundation.
