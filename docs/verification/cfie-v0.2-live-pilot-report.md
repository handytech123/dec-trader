# CFIE v0.2 read-only live pilot report

- Pilot date: 2026-09-30
- Authority: read-only observation only
- Solana source: public mainnet RPC
- Coinbase source: public unauthenticated Exchange WebSocket
- Coinbase product: `SOL-USD`
- Local storage: `.atl-data/cfie-pilot`
- Approved retention: 7 days
- Trading authority: none

## Executive result

CFIE successfully recorded real Solana and Coinbase observations without a wallet, private key,
exchange credential, signing capability, transaction submission, order placement, or autonomous
capital allocation. The pilot produced a usable primary-data corpus and verified the live
collection, normalization, atomic persistence, reconnect boundary, and fail-closed behavior.

The pilot also identified three material production-readiness constraints:

1. Solana mainnet blocks now contain version-1 transactions, requiring the collector to advertise
   version-1 support.
2. Coinbase currently rejects unauthenticated `level2` subscriptions, so this credential-free pilot
   collected trades and heartbeats but no L2 book data.
3. Lossless raw-block storage is duplicated and expanded across JSONB and base64 representations,
   producing 4.72 GB from only 311 blocks. Longer collection is paused pending storage redesign.

## Cumulative recorded dataset

| Record type                              |   Count |
| ---------------------------------------- | ------: |
| Immutable Solana raw blocks              |     311 |
| Canonical capital events                 | 264,334 |
| Distinct Solana transactions represented |  67,106 |
| Address entities                         |  96,050 |
| Assets observed in events                |   1,707 |
| Raw Coinbase messages                    |   3,193 |
| Canonical Coinbase trades                |   2,155 |
| Order-book snapshots                     |       0 |

The capital-event timestamps span `2026-09-30T16:24:07Z` through `2026-09-30T16:25:31Z`. Coinbase
trade timestamps span `2026-09-30T16:21:03.933Z` through `2026-09-30T16:42:32.827Z`. The common
overlapping event-time window is therefore limited to approximately 84 seconds even though the
collector processes were observed for more than the approved 15 minutes in aggregate.

## Successful completion segment

The final post-fix segment ran from `2026-09-30T16:37:38.062Z` through `2026-09-30T16:43:09.392Z`
and completed normally.

| Metric                     |          Result |
| -------------------------- | --------------: |
| Configured duration        |     300 seconds |
| Actual wall duration       | 331.330 seconds |
| Solana polls               |               9 |
| Solana batches             |               9 |
| Solana blocks              |              90 |
| Solana gaps                |               0 |
| Solana collection failures |               0 |
| Capital events inserted    |          78,323 |
| Coinbase connections       |               1 |
| Coinbase reconnects        |               0 |
| Coinbase messages handled  |             964 |
| New raw Coinbase messages  |             963 |
| New Coinbase trades        |             663 |

The completion segment averaged approximately 0.272 finalized blocks and 236.4 inserted capital
events per wall-clock second. It produced approximately 870 capital events per block. These figures
measure this local PGlite implementation with full lossless duplication; they are not production
PostgreSQL capacity claims.

## Coinbase message composition

| Message type    | Count |
| --------------- | ----: |
| `match`         | 2,152 |
| `heartbeat`     | 1,035 |
| `last_match`    |     3 |
| `subscriptions` |     2 |
| `error`         |     1 |

The single error came from the initial request for `level2`. Coinbase reported that `level2`,
`level3`, and `full` now require authentication. The collector was changed to the permitted public
`matches` and `heartbeat` channels and did not request credentials. Coinbase's official overview
identifies `wss://ws-feed.exchange.coinbase.com` as the public production endpoint and documents
subscription and sequence behavior:
<https://docs.cdp.coinbase.com/exchange/websocket-feed/overview>.

Because L2 was unavailable inside the approved no-credential boundary, no order-flow book features
or book snapshots should be inferred from this pilot.

## Recovered live-data failures

### Solana transaction version

The first attempt stopped before committing a Solana block because the RPC returned error `-32015`:
a version-1 transaction was present while the request declared support only through version 0. The
provider now declares `maxSupportedTransactionVersion: 1`, and the complete quality gate passes.

### PostgreSQL JSONB Unicode limitation

The longer attempt encountered a raw block containing a Unicode NUL escape. PostgreSQL JSONB cannot
represent U+0000, so the atomic transaction rolled back and the bounded retry budget stopped the
collector rather than advancing the checkpoint past an unrecorded block.

Migration `0014_lossless_raw_payloads.sql` now stores an exact base64 copy of the parsed JSON beside
a queryable JSONB projection in which U+0000 is replaced by U+FFFD. Content hashes remain calculated
from the original unsanitized object. A regression test verifies that a NUL-containing payload can
be persisted without losing the exact representation.

## Storage benchmark

The pilot directory occupies **4,720,591,729 bytes**, approximately **4.72 GB decimal** or **4.40
GiB**.

| Relation                     |          Total size | Share of pilot directory |
| ---------------------------- | ------------------: | -----------------------: |
| `raw_observations`           | 1,731,780,608 bytes |                   36.69% |
| `raw_chain_blocks`           | 1,731,518,464 bytes |                   36.68% |
| `capital_events`             |   258,449,408 bytes |                    5.47% |
| `entities`                   |    63,332,352 bytes |                    1.34% |
| `raw_public_market_messages` |     2,703,360 bytes |                    0.06% |
| `canonical_market_events`    |     1,581,056 bytes |                    0.03% |

The two raw Solana relations consume approximately **3.46 GB**, or **73.37%** of the complete pilot
directory. The remaining space includes other relations, indexes, and PostgreSQL write-ahead logs.

This layout is not acceptable for seven-day continuous retention. The primary cause is storing each
block in both `raw_observations` and `raw_chain_blocks`, with both a JSONB projection and an exact
base64 representation. The original pilot data has been retained, but further collection was paused
while the replacement path was implemented.

## Post-pilot storage redesign

Migration `0015_content_addressed_raw_objects.sql` adds one immutable content-addressed raw-object
store. New chain and market writes serialize the exact parsed JSON once, use fast gzip compression,
store it under its content hash, and keep only small raw-object references in observation and block
metadata tables. Retrieval decompresses, parses, and verifies the original content hash.

Capital-event assets, entities, and events are now inserted in batches rather than one database
round trip per record. Identity-collision checks remain fail-closed and the complete transaction
remains idempotent.

Three retained live blocks were replayed into an isolated database using the new layout:

| Storage redesign benchmark              |                                  Result |
| --------------------------------------- | --------------------------------------: |
| Blocks                                  |                                       3 |
| Capital events                          |                                   2,997 |
| Exact uncompressed raw JSON             |                        26,564,117 bytes |
| Compressed raw objects                  |                         3,377,225 bytes |
| Compression ratio                       |                                   7.87× |
| `raw_objects` relation                  |                         3,596,288 bytes |
| `raw_observations` relation             |                            81,920 bytes |
| `raw_chain_blocks` relation             |                            49,152 bytes |
| Total raw-object and metadata relations |                         3,727,360 bytes |
| Batched persistence time                |                           6.631 seconds |
| Batched persistence throughput          | approximately 452 capital events/second |

Using the pilot's average duplicated raw-relation size as the comparison baseline, the new raw
layout is approximately nine times smaller. This is an inference from a three-block sample, not a
seven-day capacity guarantee. The storage duplication is fixed for new writes. Persistence
throughput is improved but remains below the rate required to stay continuously near the Solana
chain head on this local PGlite implementation.

## Quality and safety verification

After both live compatibility fixes:

- 130 of 130 tests pass across 28 files.
- All 18 transactional migrations pass.
- All 19 workspace package boundaries pass.
- Formatting, ESLint, TypeScript build, fixtures, and the no-live-capability guard pass.
- Both observed failures rolled back or stopped safely; neither advanced authority or submitted an
  external transaction.

The final result manifest is stored at `.atl-data/cfie-pilot/pilot-result.json`. The PGlite database
is stored at `.atl-data/cfie-pilot/research-db`.

## Decoupled capture and normalization benchmark

Migration `0016_chain_normalization_queue.sql` adds a durable, lease-based queue. Raw blocks,
metadata, and normalization jobs commit atomically; the checkpoint can advance without waiting for
capital-event normalization. Expired processing leases are reclaimable, successful replay is
idempotent, and poison blocks stop after a bounded attempt count.

Three retained live blocks containing 2,997 capital events were processed in a new isolated local
database. With parallelism set to three, raw capture completed in **1.805 seconds** (**1.66
blocks/second**). The asynchronous normalizer completed in **5.563 seconds**, or **0.54
blocks/second** and **539 capital events/second**, with three completed jobs and no retries or
failures. The collector and worker now support independently bounded parallelism, but PGlite
serializes the heavy local writes, so parallelism did not materially improve this benchmark. This
small test proves separation and recovery semantics; deployed PostgreSQL testing remains necessary
before a continuous near-head claim.

The live pilot entry point now runs capture, Coinbase observation, and the normalization worker
concurrently. Capture checks durable queue depth before each poll and pauses at its configured
backpressure ceiling. The manifest records queue state before the final bounded drain and after it,
making unprocessed or failed work explicit rather than silently ending a run.

## Retention enforcement and operational status

Migration `0017_raw_retention_control.sql` adds bounded, audited raw retention. Exact raw objects
can be deleted only inside an explicitly enabled transaction-local retention capability. Updates
remain forbidden, active normalization jobs make their raw objects ineligible, and normalized
capital and market events remain intact. Each run records its cutoff, object cap, deleted object and
byte totals, metadata counts, and execution time in an immutable audit table.

The pilot applies its approved retention window after the final queue drain. A standalone retention
command additionally requires `--enable-retention-prune`, `--retention-days`, and a bounded
`--maximum-objects` value. A read-only operational status command reports queue state and the ten
most recent retention audits. Tests verify active-job protection, terminal chain-object pruning,
normalized-event preservation, market-frame pruning, and audit retrieval.

## Unified replay benchmark

The retained database was loaded into the unified timeline twice using an `asOf` cutoff later than
all pilot events. Both runs returned the same replay hash:

`sha256:5adeffd482e8a3a9843f5c73641d161a44f9e4ac10ba79e0a0d5f17a9cda432d`

| Replay metric                                 |                             Result |
| --------------------------------------------- | ---------------------------------: |
| Capital events                                |                            264,334 |
| Market events                                 |                              2,155 |
| Unified timeline events                       |                            266,489 |
| Database load and object construction         |                      5.721 seconds |
| Timeline construction and hashing             |                      2.920 seconds |
| Timeline throughput                           | approximately 91,259 events/second |
| Incremental heap during timeline construction |                  371,289,240 bytes |

This validates deterministic point-in-time replay at the pilot's corpus size. It does not yet test
million-event windows, streaming replay, or memory-bounded chunking.

## Decision before the next collection

Do not start another sustained pilot until the remaining ingestion-throughput bottleneck is
addressed. The content-addressed compressed raw-object store is complete for new writes, but local
persistence processed only about 452 capital events per second on the real three-block sample.

After that redesign, rerun a continuous, aligned pilot and measure:

- raw and normalized bytes per block over a larger sample;
- blocks and capital events per second;
- p50, p95, and p99 persistence latency;
- checkpoint lag behind the finalized chain head;
- overlapping Solana and Coinbase event-time coverage;
- replay throughput above one million events with memory-bounded loading;
- projected seven-day storage using measured post-compression rates.

The Coinbase book-data decision remains separate: either preserve the no-credential boundary and
accept trade-only market data, or explicitly approve a narrowly scoped read-only market-data
credential in a later phase. This pilot did not cross that boundary.
