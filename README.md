# Autonomous Trading Laboratory

**CURRENT CFIE AUTHORITY: READ-ONLY RESEARCH. EXECUTION AUTHORITY: NONE.**

A safety-first platform for reproducible trading research. The authoritative requirements and safety
contract are in [`docs/ENGINEERING_SPEC.md`](docs/ENGINEERING_SPEC.md).

## Safety status

The laboratory now supports offline deterministic replay, cost-aware backtesting and paper fills,
real DEX market-data collection, point-in-time feature snapshots, forward-outcome labeling, and
read-only Solana mint safety assessment. The capital-flow foundation adds canonical on-chain events,
evidence-qualified entities and relationships, and point-in-time exchange-flow anomaly features. It
intentionally has no wallet, signing, transaction-building, transaction-submission, or live-trading
implementation. Tests remain network-independent; real provider access occurs only through explicit
collection commands.

CFIE v0.2 is the implementation authority for new capital-flow work. Its Phase 0 completion mapping
is recorded in
[`docs/verification/cfie-v0.2-phase-0-report.md`](docs/verification/cfie-v0.2-phase-0-report.md).
The fixture-driven, read-only Phase 1.1 Solana collector is documented in
[`docs/verification/cfie-v0.2-phase-1.1-report.md`](docs/verification/cfie-v0.2-phase-1.1-report.md).
Subsequent fixture-safe Phase 1 foundations are tracked in
[`docs/verification/cfie-v0.2-phase-1-progress.md`](docs/verification/cfie-v0.2-phase-1-progress.md).
The current implementation and benchmark inventory is in
[`docs/verification/cfie-v0.2-status-and-benchmark-report.md`](docs/verification/cfie-v0.2-status-and-benchmark-report.md).
The first bounded primary-data run is documented in
[`docs/verification/cfie-v0.2-live-pilot-report.md`](docs/verification/cfie-v0.2-live-pilot-report.md).
Current demonstration readiness is summarized in
[`docs/verification/cfie-demo-readiness.md`](docs/verification/cfie-demo-readiness.md). The latest
public-provider validation is recorded in
[`docs/verification/cfie-provider-validation-2026-10-02.md`](docs/verification/cfie-provider-validation-2026-10-02.md).
Current connection coverage is recorded in
[`docs/verification/cfie-data-connections-2026-10-02.md`](docs/verification/cfie-data-connections-2026-10-02.md).

## Development

Requirements: Node.js 22.17 or later and pnpm 11.5.1.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:coverage
```

Build and launch the deterministic CFIE demonstration at `http://127.0.0.1:4173`:

```sh
pnpm demo:cfie
```

The command creates or idempotently refreshes `.atl-data/cfie-demo`, processes a recorded Solana
block through the durable normalization queue, records synthetic Coinbase SOL-USD trades, and opens
the read-only dashboard service. It does not contact a network provider or expose execution
authority.

Research operations:

```sh
pnpm discover:solana
pnpm collect:dex -- --watchlist .atl-data/solana-research-watchlist.json --top-pools 3
pnpm inspect:safety
pnpm inspect:routes
pnpm inspect:integrity
pnpm shadow
pnpm paper:lab -- --run-paper-lab
pnpm report:data
```

The paper-style laboratory evaluates fixed trend and mean-reversion rules with point-in-time CFIE
protocol/capital-flow context. A style remains `RESEARCH_ONLY` until it has at least 100 qualifying
samples and passes chronological future folds after the configured cost model. The coordinator then
chooses one approved style or `NO_TRADE`; an independent paper-risk gate, conservative simulated
fill model, immutable portfolio ledger, and one-hour event-sourced exit lifecycle remain entirely
paper-only. The continuous derivation service refreshes this laboratory hourly.

Bounded public observation is disabled unless the explicit enable flag and every limit are supplied.
Replace the placeholders only after approving the endpoints, products, starting slot, and storage
location:

Set `CFIE_SOLANA_RPC_URL` in the process environment to keep provider credentials out of command
history. The Solana observation commands use that variable when their RPC option is omitted.

Database-taking commands accept either a local PGlite directory or a `postgresql://` URL. Keep the
URL in `CFIE_DATABASE_URL` or pass it to `--database`/`--database-path`; never commit it.

```sh
pnpm observe:solana -- --enable-read-only-observation --rpc-endpoint <HTTPS_RPC> --initial-slot <SLOT> --max-batch-slots <1-500> --max-polls <1-10000> --poll-interval-ms <250-60000> --max-consecutive-failures <0-20> --failure-backoff-ms <250-60000> --max-duration-seconds <1-3600> --database <PATH>

pnpm observe:coinbase -- --enable-read-only-observation --websocket-endpoint <WSS_ENDPOINT> --products <PRODUCTS> --max-messages <1-1000000> --max-duration-seconds <1-3600> --max-reconnects <0-20> --base-reconnect-ms <100-30000> --max-reconnect-ms <100-60000> --connection-timeout-ms <1000-30000> --database <PATH>
```

Optional public Coinbase trade-gap recovery is enabled only when all REST limits are explicit:

```sh
pnpm observe:coinbase -- <OPTIONS_ABOVE> --rest-endpoint https://api.exchange.coinbase.com --rest-timeout-ms 10000 --max-backfill-trades 100
```

The adapter requests only public product trades and supplies no API key or trading credential.

Free historical Binance Vision trades can be imported with an explicit read-only gate and hard
archive, record, timeout, and transaction-batch limits. These records remain labeled
`binance-spot`/`SOLUSDT`; they are never presented as Coinbase or SOL-USD observations:

```sh
pnpm backfill:binance -- --enable-read-only-backfill --symbol SOLUSDT --kind aggTrades --interval daily --period 2021-01-01 --database .atl-data/research-db --max-archive-bytes 50000000 --max-records 1000000 --batch-size 1000 --timeout-ms 120000
```

The importer verifies Binance's published SHA-256 checksum before extraction, retains the raw row
behind every canonical event, supports millisecond and microsecond archives, and is idempotent by
provider trade ID. Historical Binance outcomes must be analyzed as a separate venue/quote-asset
dataset and then confirmed against forward Coinbase collection.

The combined pilot can also run as a bounded soak (up to 24 hours). This conservative
public-provider example records both streams and drains the normalization queue before writing its
manifest:

```sh
pnpm observe:pilot -- --enable-read-only-observation --solana-rpc <HTTPS_RPC> --coinbase-websocket wss://ws-feed.exchange.coinbase.com --coinbase-rest https://api.exchange.coinbase.com --coinbase-product SOL-USD --duration-seconds 900 --retention-days 7 --solana-poll-interval-ms 10000 --solana-max-batch-slots 2 --solana-max-parallel-blocks 1 --output-directory .atl-data/cfie-pilot

pnpm soak:evaluate -- --manifest .atl-data/cfie-pilot/pilot-result.json
```

The evaluator exits unsuccessfully when Solana failures, feed incidents, undrained work, or failed
normalization jobs exceed their thresholds. Its minimum/maximum thresholds are explicit CLI options.
A dedicated Solana endpoint is recommended for sustained near-head collection. Keep provider keys in
environment-backed configuration and out of commands, manifests, and tracked files.

The restart-safe continuous collector adds a database lease, durable market cursors, bounded gap
recovery, cycle retry/backoff, atomic health manifests, Solana queue draining, Coinbase SOL/USD
trades, and Binance.US SOL/USDT trades plus Level 2 depth. Raw observations are retained
indefinitely when `--retention-days 0` is used:

```sh
pnpm collect:service -- --enable-read-only-service --output-directory .atl-data/cfie-service --database .atl-data/cfie-service/research-db --solana-rpc https://api.mainnet-beta.solana.com --coinbase-websocket wss://ws-feed.exchange.coinbase.com --coinbase-rest https://api.exchange.coinbase.com --coinbase-product SOL-USD --coinbase-basis-product USDT-USD --binance-websocket wss://stream.binance.us:9443 --binance-rest https://api.binance.us --binance-symbol SOLUSDT --binance-venue binance-us-spot --max-runtime-seconds 604800 --segment-seconds 3600 --retention-days 0 --max-cycle-failures 10 --failure-backoff-seconds 30 --solana-poll-interval-ms 250 --solana-rpc-min-request-interval-ms 300 --reference-interval-ms 10000 --solana-max-batch-slots 25 --solana-max-parallel-blocks 1
```

See
[`docs/verification/cfie-continuous-collector-2026-10-03.md`](docs/verification/cfie-continuous-collector-2026-10-03.md)
for restart semantics, venue boundaries, and the live multivenue benchmark.

Each completed service cycle computes and durably stores a two-venue SOL/USD reference estimate.
Coinbase USDT-USD is collected as an explicit quote-conversion basis; USDT is never assumed to equal
USD. The engine withholds estimates that lack two fresh venues, have stale basis data, cross or
widen their books beyond policy, or diverge beyond the configured threshold. A point-in-time
estimate can also be recomputed deterministically:

```sh
pnpm reference:compute -- --database .atl-data/cfie-service/research-db --binance-venue binance-us-spot --binance-symbol SOLUSDT --as-of <ISO_TIMESTAMP> --maximum-age-ms 30000 --maximum-basis-age-ms 60000 --maximum-deviation-bps 100 --maximum-spread-bps 100
```

See
[`docs/verification/cfie-reference-price-engine-2026-10-03.md`](docs/verification/cfie-reference-price-engine-2026-10-03.md)
for the live estimate and confidence-policy validation.

Published reference prices are joined to native SOL capital events without future leakage. Matured
1-minute, 5-minute, 15-minute, 1-hour, 6-hour, and 24-hour outcomes include return and favorable/
adverse excursion measurements. The continuous collector labels matured observations each cycle;
manual deterministic labeling is also available:

```sh
pnpm outcomes:capital -- --database .atl-data/cfie-service/research-db --as-of <ISO_TIMESTAMP> --maximum-entry-age-seconds 30 --maximum-exit-delay-seconds 60
```

See
[`docs/verification/cfie-forward-outcome-labeling-2026-10-03.md`](docs/verification/cfie-forward-outcome-labeling-2026-10-03.md)
for the point-in-time and maturation rules.

Phase 1 research is preregistered and executed separately from collection. The protocol database
holds immutable hypotheses and results; `--data-database` may point at a separate observation
dataset. A run fails closed as `INSUFFICIENT_DATA` when registered sample requirements are not met.

```sh
pnpm research:freeze -- --freeze-protocol --database .atl-data/cfie-research-phase-1/research-db --dataset-cutoff 2026-10-03T08:04:14.0627744Z
pnpm research:run -- --run-research --protocol-database .atl-data/cfie-research-phase-1/research-db --data-database .atl-data/cfie-service/research-db --protocol-id protocol_6544TAPR7FXC96R5BVW8582PZP --output .atl-data/cfie-research-phase-1/transfer-magnitude-run.json

# Run the preregistered point-in-time entity-direction/protocol cohort analysis.
pnpm research:run -- --run-research --family DIRECTION --protocol-database .atl-data/cfie-research-phase-1/research-db --data-database .atl-data/cfie-service/research-db --protocol-id protocol_6544TAPR7FXC96R5BVW8582PZP --output .atl-data/cfie-research-phase-1/direction-run.json

# Materialize immutable one-minute Coinbase market reactions for eligible SOL events.
pnpm reactions:market -- --compute-market-reactions --database .atl-data/cfie-service/research-db --venue coinbase-exchange --instrument-id instrument_67PZNJPGRSW37SZX85J3BNQ8TQ --window-seconds 60 --maximum-events 1000
```

The continuous collector performs the same maturation automatically after every successful segment
for Coinbase SOL/USD and Binance.US SOL/USDT. Use `--max-reaction-events-per-window` and
`--reaction-snapshot-age-seconds` to keep each pass bounded.

The initial transfer-magnitude family uses only prior observations to calculate event Z-scores,
reserves the latest 20% as a chronological holdout, uses deterministic permutation tests, and
controls multiple comparisons with the preregistered Benjamini-Hochberg policy. It does not emit
trading instructions.

Operational health, source freshness, normalization queue state, and recent immutable retention
audits can be inspected without enabling collection. Raw retention is separately gated and always
bounded:

```sh
pnpm operations:status -- --database-path <PATH> --freshness-seconds 300 --max-pending-jobs 1000
pnpm retention:prune -- --enable-retention-prune --database-path <PATH> --retention-days 7 --maximum-objects 10000
```

Retention never removes raw objects needed by pending or processing normalization jobs. It preserves
normalized research events and records every completed prune in the retention audit table.

The observation commands read public data and record it; they expose no order, wallet, signing, or
transaction-submission operation. No default endpoint or product is selected.

Verified Solana entity addresses are imported from a versioned, evidence-backed JSON registry.
Attribution is point-in-time and never guesses a label for an unknown address:

```sh
pnpm entities:import -- --database .atl-data/cfie-service/research-db --registry <REGISTRY_JSON>
```

Use `--audit-only` first for a non-mutating conflict, source-diversity, and interval-overlap report.
Imports are atomic and reject attribution conflicts with records already stored.

Primary-source maintenance manifests can be fetched and verified automatically. Each claimed address
must appear in its cited HTTPS document; the exact response is content-hashed and retained as
immutable raw evidence. Unchanged evidence is idempotent:

```sh
pnpm entities:sync -- --manifest config/entity-sources.primary.json --audit-only
pnpm entities:sync -- --manifest config/entity-sources.primary.json --database .atl-data/cfie-service/research-db --enable-entity-registry-write
```

Point-in-time wallet behavior for a stored event can be inspected without mutation. The result
includes transfer-size Z-score, dormancy, prior 24-hour frequency, counterparty novelty, and exact
prior-event evidence IDs:

```sh
pnpm entities:inspect -- --database .atl-data/cfie-service/research-db --event-id <EVENT_ID> --entity-id <ENTITY_ID>
```

The dashboard server exposes the same read-only result at
`/api/entity-intelligence?eventId=<EVENT_ID>&entityId=<ENTITY_ID>`.

The optional enhanced WebSocket path is separately gated and bounded. Supply its WSS URL through
`CFIE_SOLANA_WEBSOCKET_URL` so provider credentials do not appear in command history. Confirmed
messages are stored losslessly, then independently reconciled against finalized RPC blocks before
they can be treated as research evidence:

```sh
pnpm observe:filtered-solana -- --enable-read-only-filtered-stream --database .atl-data/cfie-service/research-db --max-duration-seconds 900 --max-messages 100000
pnpm reconcile:filtered-solana -- --enable-read-only-reconciliation --database .atl-data/cfie-service/research-db --limit 1000
```

`report:data` labels assets only as research-eligible or excluded. It does not emit investment
advice or live orders. A strategy cannot be described as validated until sufficient forward labels
exist and its locked rules pass walk-forward evaluation including costs and a no-trade baseline.

The design package, security documentation, ADRs, and phase acceptance mappings live under
[`docs/`](docs/).
