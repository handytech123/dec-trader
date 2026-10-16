# CFIE reference-price engine validation — 2026-10-03

## Outcome

CFIE now derives a durable SOL/USD research reference from independent Coinbase and Binance.US
evidence. It does not assume USDT equals USD: Coinbase USDT-USD observations are collected and
attached as explicit conversion evidence.

The engine is a research estimator, not a blockchain oracle or an executable quote.

## Publication policy

An estimate is published only when all of the following hold:

- at least two independent venues remain after validation;
- every source observation is at or before the point-in-time cutoff;
- market observations are at most 30 seconds old;
- the USDT/USD basis is at most 60 seconds old;
- book bids do not exceed asks and spreads remain within 100 basis points;
- venue estimates remain within 100 basis points of the robust center.

Observations are aggregated within each venue before the cross-venue median is calculated, so a
high-message-rate venue cannot dominate the estimate. A confidence interval uses the greater of a
one-basis-point floor, cross-venue disagreement, and half the observed spread. Quality combines
venue coverage, freshness, and agreement on a zero-to-one scale.

Every published or withheld result stores its configuration hash, evidence references, rejection
reasons, venue estimates, confidence bounds, quality score, and deterministic content hash in the
immutable `reference_price_snapshots` table.

## Live validation

A 60-second public-data collection produced:

- 83 Coinbase SOL/USD trades;
- 5 Coinbase USDT/USD basis trades;
- 28 Binance.US Level 2 snapshots;
- 5 finalized Solana blocks and 1,709 normalized capital events;
- zero reconnects, sequence incidents, or failed normalization jobs.

The original 15-second freshness configuration correctly withheld publication because the latest
Coinbase SOL trade was 16.243 seconds old. Replaying the exact same immutable evidence with the
research policy's 30-second ceiling produced:

| Field               | Result              |
| ------------------- | ------------------- |
| Status              | `PUBLISHED`         |
| Reference SOL/USD   | `119.447344625`     |
| Confidence low      | `119.4353998905375` |
| Confidence high     | `119.4592893594625` |
| Uncertainty         | `1` basis point     |
| Quality score       | `0.83457`           |
| Coinbase estimate   | `119.44`            |
| Binance.US estimate | `119.45468925`      |
| Rejected evidence   | none                |
| Evidence references | 3 immutable hashes  |

This fail-closed then deterministic-replay sequence demonstrates that policy changes do not rewrite
observations or silently force publication.

## Verification gates

The engine has fixture tests for deterministic input ordering, quote-basis absence, future data,
staleness, crossed/wide books, venue outliers, confidence bounds, evidence inclusion, durable
persistence, and idempotent recomputation. Repository-wide safety gates continue to prohibit wallet,
signing, transaction-submission, and order-placement capabilities.
