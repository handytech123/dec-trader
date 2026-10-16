# CFIE continuous collector validation — 2026-10-03

## Outcome

CFIE now has a restart-safe, read-only continuous collection service for finalized Solana blocks,
Coinbase SOL/USD trades, Binance.US SOL/USDT aggregate trades, and Binance.US Level 2 depth. The
service owns no wallet, signing, transaction-submission, order-placement, or capital-allocation
capability.

## Durability and recovery

- Solana finalized-slot checkpoints already resume after process restart.
- Coinbase and Binance aggregate-trade IDs now have durable database checkpoints.
- A trade-ID jump creates an immutable incident before bounded public REST recovery.
- Raw messages are persisted before canonical events or order-book snapshots.
- A single-owner database lease prevents two collector instances from writing the same service.
- Each service cycle has bounded runtime, reconnects, backoff, normalization work, and queue size.
- Shutdown drains normalization work, releases the lease, and atomically replaces the health
  manifest.
- Raw observations are preserved indefinitely when `--retention-days 0` is selected (the default).

## Venue boundary

Coinbase's live server reported that its Level 2 channel now requires authentication. CFIE does not
introduce an exchange credential to bypass that boundary. Coinbase remains the independent SOL/USD
trade venue. The free live depth source is Binance.US and is labeled `binance-us-spot`; the free
historical Binance Vision archive remains labeled `binance-spot`. These datasets are never silently
relabeled or merged.

## Live multivenue smoke benchmark

A 60-second restartable service cycle used public endpoints and an isolated local PGlite database:

| Stream                      | Result                                                         |
| --------------------------- | -------------------------------------------------------------- |
| Solana finalized collection | 6 polls, 6 blocks, 0 gaps, 0 failures                          |
| Solana normalization        | 6 jobs, 4,245 capital events, 0 retries, 0 failures            |
| Coinbase SOL/USD            | 105 messages, 46 trades, 0 reconnects, 0 incidents             |
| Binance.US SOL/USDT         | 70 messages, 1 trade, 26 durable L2 snapshots, 0 reconnects    |
| Raw market persistence      | 176 new raw messages across both market venues                 |
| Shutdown                    | Queue drained, lease released, immutable retention audit ready |

The Binance.US book retains every raw 100 ms delta while materializing a bounded full-book snapshot
at most once per second. Sequence gaps fail the current connection, create an incident, reload a
REST snapshot, and reconnect rather than continuing from corrupt state.

## Operating command

Provider credentials belong in process environment variables, not command history or source control.
The following public-endpoint example is intentionally bounded to seven days so an external service
manager can restart it and verify its exit status:

```sh
pnpm collect:service -- --enable-read-only-service --output-directory .atl-data/cfie-service --database .atl-data/cfie-service/research-db --solana-rpc https://api.mainnet-beta.solana.com --coinbase-websocket wss://ws-feed.exchange.coinbase.com --coinbase-rest https://api.exchange.coinbase.com --coinbase-product SOL-USD --coinbase-basis-product USDT-USD --binance-websocket wss://stream.binance.us:9443 --binance-rest https://api.binance.us --binance-symbol SOLUSDT --binance-venue binance-us-spot --max-runtime-seconds 604800 --segment-seconds 3600 --retention-days 0 --max-cycle-failures 10 --failure-backoff-seconds 30 --solana-poll-interval-ms 250 --solana-rpc-min-request-interval-ms 300 --reference-interval-ms 10000 --solana-max-batch-slots 25 --solana-max-parallel-blocks 1
```

For sustained use, `CFIE_SOLANA_RPC_URL` should contain the dedicated Solana RPC endpoint and
`CFIE_DATABASE_URL` should point at PostgreSQL. Omitting `--solana-rpc` and `--database` then keeps
both values out of the process command line.

### Public-RPC cadence follow-up

A later sustained-cadence validation showed why the public Solana endpoint must not be treated as a
production source. A 10-second poll with a two-slot batch fell behind the finalized head. Increasing
the catch-up rate triggered HTTP 429 responses. CFIE now supports
`--solana-rpc-min-request-interval-ms` and serializes request starts through one bounded gate, but
the public endpoint still returned 429 responses during the validation window. No slots were skipped
and no forward outcomes were fabricated. A dedicated RPC endpoint is therefore an operational
requirement for uninterrupted research collection, not a requirement of the analysis architecture.

## Remaining production operations

The collector process is ready to be supervised, but installing it as an operating-system service is
environment-specific and should happen only after choosing how the host securely injects the RPC and
database secrets. Storage-capacity alerts and cold-object export should be added before an unbounded
raw archive is left running for months.
