# CFIE Market-Reaction Features — 2026-10-04

## Outcome

CFIE now has a deterministic version-one feature engine for measuring how the market responds after
a capital event. It computes measurements only; it does not produce a trade recommendation.

## Features

- Bid/ask spread before and after the event, in basis points
- Bid, ask, and total notional depth changes over a bounded number of levels
- Aggressive buy and sell volume
- Aggressor imbalance
- Total traded volume
- Realized volatility from ordered trade prices
- Mid-price return
- Absorption: signed aggressive volume per absolute basis point of mid-price movement
- Sorted input event identifiers for evidence reconstruction

Empty books, crossed books, invalid prices, negative sizes, negative trade quantities, and unbounded
depth requests fail closed or return an explicit null when a metric is undefined.

## Boundary

This component contains no wallet, transaction signing, submission, exchange authentication, order
placement, or capital-allocation capability.

## Durable integration

Migration 0027 adds immutable, uniquely keyed feature records for each capital event, venue,
instrument, horizon, and algorithm version. The bounded worker:

- considers only native-SOL events whose reaction window has matured;
- requires a pre-event book no older than the configured freshness limit;
- requires a post-event book inside the registered horizon;
- caps the number of events, trades, and book levels processed;
- records exact before/after snapshot hashes and contributing trade IDs;
- is idempotent and fails on identity collisions.

The first active-database pass found zero eligible event windows because the existing chain and
order-book histories do not overlap closely enough. It therefore wrote no misleading partial
features. Continuous synchronized collection is required for these records to begin maturing.

## Continuous maturation

The supervised collection service now runs a bounded maturation pass after every successful
collection segment for Coinbase SOL/USD and Binance.US SOL/USDT. It evaluates all six registered
horizons, limits candidates per venue and horizon, isolates individual event failures, and writes
its completed/failed counts into the service manifest. Collection remains read-only if reaction
computation has no eligible events.
