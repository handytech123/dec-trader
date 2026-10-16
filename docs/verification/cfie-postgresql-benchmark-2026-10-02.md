# CFIE PostgreSQL validation and benchmark — 2026-10-02

## Environment

- PostgreSQL 17.11 on Windows
- Loopback TCP connection
- Dedicated non-superuser role and research database
- Credentials protected outside the repository with Windows DPAPI
- 18 CFIE migrations and 37 public research tables

The repository now accepts either a PGlite directory or a `postgresql://` connection URL through the
same `ResearchDatabase` interface. Transactions, row counts, migrations, and shutdown semantics are
normalized by the adapter. No database credential is committed.

## Server baseline

`pgbench` scale 10, eight clients, four threads, and a 20-second run:

| Metric                  |        Result |
| ----------------------- | ------------: |
| Transactions            |       227,162 |
| Failed transactions     |    0 (0.000%) |
| Throughput              | 11,399.94 TPS |
| Average latency         |      0.701 ms |
| Initial connection time |     74.224 ms |

This is an infrastructure baseline, not a CFIE ingestion-rate claim.

## CFIE normalization workload

Four retained live Solana blocks containing 2,483 normalized capital events were replayed into fresh
PostgreSQL databases.

| Configuration | Capture blocks/s | Normalize blocks/s | Normalize events/s | Retries | Failures |
| ------------- | ---------------: | -----------------: | -----------------: | ------: | -------: |
| One worker    |            3.199 |              0.847 |            525.474 |       0 |        0 |
| Four workers  |            3.373 |              0.643 |            398.934 |       1 |        0 |

The one-worker configuration was 31.7% faster by normalized-event throughput. Concurrent blocks
often touch the same assets and entities, so additional workers introduce write contention without
improving this small workload. Keep one normalization worker as the measured PostgreSQL default
until a larger sample supports a different setting.

The completed 15-minute soak then supplied a 100-block replay corpus:

| Metric                       |           Result |
| ---------------------------- | ---------------: |
| Captured blocks              |              100 |
| Capture throughput           |   3.107 blocks/s |
| Completed normalization jobs |              100 |
| Capital events               |           58,436 |
| Normalization throughput     |   0.934 blocks/s |
| Capital-event throughput     | 545.791 events/s |
| Retried / failed jobs        |            0 / 0 |

The larger replay increased event throughput by 3.9% over the four-block serial sample and completed
without retries or failures.

## Remaining limitations

- The benchmark is local-loopback and does not include networked production-database latency.
- Production storage, backup, monitoring, and connection-pool limits remain deployment decisions.
