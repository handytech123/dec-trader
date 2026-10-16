# CFIE capital-event forward labeling — 2026-10-03

## Outcome

CFIE now connects native SOL capital events to the reference-price timeline and creates immutable,
leakage-safe forward outcomes at 1-minute, 5-minute, 15-minute, 1-hour, 6-hour, and 24-hour
horizons.

## Leakage controls

- The entry estimate must be `PUBLISHED`, must exist at or before the capital event, and may be at
  most 30 seconds old.
- Future observations are never used to establish the event's entry price.
- The exit is the first published estimate at or after the exact target horizon and no more than 60
  seconds late.
- Maximum favorable and adverse excursions use only published estimates between entry and exit.
- Event, entry snapshot, exit snapshot, timestamps, prices, horizon, excursions, policy version, and
  labeling time are covered by an immutable content hash.
- Re-running the labeler is idempotent by capital event, horizon, and labeling version.

Only native SOL transfers are labeled against SOL/USD. Other SPL assets are not assigned SOL price
outcomes.

## Live cadence validation

A 70-second public-data run produced:

- 6 finalized Solana blocks;
- 2,880 normalized capital events;
- 48 Coinbase SOL/USD trades;
- 19 Coinbase USDT/USD basis trades;
- 42 Binance.US Level 2 snapshots;
- 6 reference-price computations, all 6 published;
- zero feed incidents, reconnects, queue failures, or withheld estimates.

No live outcome had matured during that short run. This is expected: the first label requires both a
pre-event published estimate and a later estimate at least one minute after that event. Fixture
integration tests cover maturation, exact return calculation, immutable persistence, native-SOL
filtering, and idempotent re-labeling.

The continuous collector computes reference estimates every 10 seconds by default and attempts
forward labeling at the end of each service cycle. Outcomes can also be labeled manually:

```sh
pnpm outcomes:capital -- --database .atl-data/cfie-service/research-db --as-of <ISO_TIMESTAMP> --maximum-entry-age-seconds 30 --maximum-exit-delay-seconds 60
```

These outcomes are research labels only. They do not generate orders, recommendations, or capital
allocation decisions.
