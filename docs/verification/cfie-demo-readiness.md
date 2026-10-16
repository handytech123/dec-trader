# CFIE demonstration readiness

- Assessment date: 2026-10-02
- Demonstration mode: deterministic offline, read-only research
- Launch command: `pnpm demo:cfie`
- Local URL: `http://127.0.0.1:4173`

## Readiness assessment

| Scope                                    |        Readiness | Current evidence                                                                                                    |
| ---------------------------------------- | ---------------: | ------------------------------------------------------------------------------------------------------------------- |
| Self-contained engineering demonstration |              95% | One-command seed/dashboard, unified timeline, evidence review, and deterministic provider paths verified            |
| CFIE v0.2 research platform              |              80% | Collection, storage, replay, evidence, recovery, queues, retention, reporting, and two live pilots completed        |
| Sustained production observation service |              84% | Dedicated RPC, healthy 15-minute soak, PostgreSQL adapter, and 100-block benchmark pass; deployment controls remain |
| Economic research conclusion             |              20% | Dataset and replay machinery exist; predictive usefulness has not been established                                  |
| Autonomous trading product               | Intentionally 0% | Wallet access, signing, submission, order placement, and capital authority remain absent                            |

Percentages are engineering judgments, not measured probabilities or investment claims.

## Demonstrated flow

```text
Recorded Solana block
  -> content-addressed raw capture
  -> durable normalization job
  -> canonical capital events and entities

Recorded Coinbase SOL-USD messages
  -> lossless raw capture
  -> canonical market events

Both streams
  -> read-only CFIE dashboard
  -> freshness, queue, incident, and authority-boundary status
```

The verified demonstration dataset contains one raw Solana block, two normalized capital events,
four entities, two assets, three Coinbase SOL-USD trades, four raw objects, one completed
normalization job, one human-review evidence packet, and zero failed jobs. Re-running the builder is
idempotent.

## Remaining work before the next live demonstration

1. Exercise Coinbase REST recovery through a naturally observed live gap.
2. Define PostgreSQL backup, monitoring, and production connection-pool limits.
3. Run progressively longer observation windows before claiming seven-day reliability.

Coinbase sequence gaps, stale/duplicate trades, and reconnect episodes are now represented as
immutable incidents. Fixture-driven backfill accepts only complete, ascending, bounded ranges and
repairs the session before admitting the current live trade. The concrete public REST adapter is
HTTPS-only, timeout-bounded, validates response shape, filters the exact missing range, and remains
disabled unless explicit REST options are supplied. Address-lookup-table account resolution and
fail-closed malformed token-balance mapping are also covered. Unsupported Token-2022 instructions
are ignored rather than inferred, and unsafe decimal precision is rejected. Operational status now
grades source freshness, feed incidents, queue depth, and failed jobs as healthy, degraded, or
unhealthy; the dashboard and CLI expose the same snapshot. A separate acceptance command converts a
completed pilot manifest into a thresholded pass/fail result.

The dedicated-RPC combined validation completed successfully: four Solana blocks produced 2,483
capital events while Coinbase produced 26 SOL-USD market events. Both feeds had zero collection
failures, gaps, reconnects, incidents, pending jobs, or failed jobs. The acceptance gate passed and
the post-run operational snapshot was healthy. A silent-WebSocket shutdown defect discovered during
validation was fixed with proactive, idempotent connection closure and regression coverage.

The 15-minute dedicated-RPC soak captured 133 Solana blocks, normalized 79,361 capital events, and
recorded 729 Coinbase trades. It had zero gaps, failures, reconnects, incidents, retries, or failed
jobs; the queue drained completely and both acceptance and health gates passed. A 100-block replay
into PostgreSQL normalized 58,436 events at 545.791 events per second with zero retries or failures.

## Safety boundary

The demonstration contains no wallet credentials, exchange keys, private keys, transaction builder,
signer, blockchain submission, exchange order placement, or autonomous capital allocation.
