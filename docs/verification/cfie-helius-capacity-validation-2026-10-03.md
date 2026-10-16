# CFIE Helius capacity validation — 2026-10-03

## Decision

Helius RPC access is validated for CFIE. The current key completed both bounded pilots with zero RPC
failures and zero detected slot gaps. The $49/month Developer tier has sufficient listed credit and
request-rate capacity for the current read-only workload. The $499/month Business tier is not
justified at this stage.

The API key was supplied only through the process environment. It is not stored in source code, Git,
database records, manifests, or this report.

## Five-minute measured pilot

| Measurement                    | Result |
| ------------------------------ | -----: |
| Finalized blocks               |    132 |
| RPC failures                   |      0 |
| Slot gaps                      |      0 |
| Capital events                 | 90,480 |
| Native SOL events              | 26,782 |
| Coinbase market events         |    181 |
| Binance.US market events       |      6 |
| Binance.US L2 snapshots        |    180 |
| USDT/USD basis events          |     77 |
| Published reference prices     |     28 |
| Withheld reference prices      |      0 |
| Matured one-minute outcomes    |  4,673 |
| Market-data incidents          |      0 |
| Normalization retries/failures |    0/0 |

This is the first live CFIE run to produce thousands of point-in-time capital-event outcomes from
the combined Solana and multivenue market timeline.

## Throughput tuning pilot

A second run increased the block batch to 50 and block concurrency to four. Helius again produced
zero RPC failures and zero gaps. The run persisted 65 blocks and 41,268 capital events. Increasing
RPC concurrency did not improve end-to-end throughput in the local PGlite configuration because full
parsed blocks are large and durable normalization/storage became the limiting stage.

This means provider RPS is no longer the immediate bottleneck. Sustained collection should use the
installed PostgreSQL service and independently benchmark the capture, normalization, and storage
stages before purchasing a larger provider tier.

## Capacity projection

Solana produces approximately 2.5 slots per second. A finalized-block collector therefore needs
about 216,000 block requests per day, plus bounded `getSlot` and `getBlocks` calls. At Helius's
published one-credit cost for ordinary, non-archival RPC calls, the current design projects to
approximately 7 million credits per 30-day month.

Published plan capacity at validation time:

| Plan      | Monthly price | Credits | Request rate | CFIE assessment          |
| --------- | ------------: | ------: | -----------: | ------------------------ |
| Free      |            $0 |      1M |       10 RPS | Short pilots only        |
| Developer |           $49 |     10M |       50 RPS | Appropriate current tier |
| Business  |          $499 |    100M |      200 RPS | Not currently justified  |

Credit consumption should be checked in the Helius dashboard after a 24-hour PostgreSQL run before
enabling automatic overages. The projection excludes archival backfills, which Helius prices at a
higher credit rate.

## PostgreSQL and capture profiling

The secure local PostgreSQL 17 service was validated with the restricted `cfie_app` role and two
isolated live databases. A three-minute Helius/PostgreSQL run captured 107 blocks, normalized 69,935
capital events, published 16 reference prices, and labeled 1,727 one-minute outcomes with zero RPC
failures or gaps.

Increasing block concurrency from four to sixteen did not materially improve capture. An isolated
network-only benchmark retrieved 10 full parsed blocks at 2.175 blocks per second, while durable
end-to-end runs remained below one block per second. The bottleneck is therefore full-block
serialization, compression, and durable capture rather than Helius request limits.

A bounded batch-transaction implementation was built and tested, then benchmarked. It reduced a
comparable capture from 115 blocks to 61 because a large transaction held compression and database
writes together too long. The production database adapter was returned to the faster per-block
transaction path. No benchmark data was discarded.

The next architectural optimization should decouple network capture from compression and storage, or
replace full-block polling with a filtered Helius stream. Purchasing the Business plan would not
solve this local processing bottleneck.

## Filtered-stream access check

CFIE attempted a bounded connection to the official Helius Enhanced WebSocket mainnet endpoint with
`transactionSubscribe`, a successful-transaction filter, version-1 transaction support, and a System
Program account filter. The current key did not open the Enhanced WebSocket connection. Ordinary
Helius RPC remained healthy before and after this test.

Helius's April 2026 access matrix lists Enhanced WebSocket `transactionSubscribe` on Developer plans
and above, while Free includes only standard WebSockets. The filtered live pilot therefore requires
the $49 Developer upgrade. It does not require the $499 Business plan or mainnet gRPC. ADR 0009
records the filtering, evidence, finalization, and gap-recovery boundaries to implement after access
is enabled.

## Safety boundary

Only `getSlot`, `getBlocks`, and `getBlock` are required. CFIE does not use Helius transaction
submission, wallet access, signing, bundles, or capital-allocation functionality.
