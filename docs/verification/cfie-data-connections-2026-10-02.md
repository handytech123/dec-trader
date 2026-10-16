# CFIE data-connection validation — 2026-10-02

## Connected and validated

| Connection                | Status         | Validation evidence                                                                      |
| ------------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| Helius finalized blocks   | Live validated | 15-minute soak, 133 blocks, zero failures or gaps                                        |
| Helius historical address | Live validated | Bounded `getTransactionsForAddress` page returned one result and a pagination token      |
| Coinbase Exchange SOL-USD | Live validated | 729 trades in the 15-minute soak, zero reconnects or incidents                           |
| Binance Vision SOL/USDT   | Live validated | 44,747 checksum-verified aggregate trades imported; idempotent rerun inserted zero       |
| Binance.US SOL/USDT live  | Live validated | Public aggregate trades and L2 depth; 26 snapshots in a 60-second service smoke test     |
| PostgreSQL 17.11          | Live validated | 18 migrations, 100-block replay, 58,436 events, zero retries or failures                 |
| Pyth Hermes v2            | Adapter ready  | Authenticated REST contract, exact decimal scaling, response and feed completeness tests |

## Helius historical boundary

The historical adapter requests successful transactions in ascending order and defaults to token
accounts whose balances changed. Address format, time windows, pagination tokens, and page sizes are
validated; one call cannot request more than 1,000 transactions. Returned provider payloads remain
untrusted until the existing raw-storage and normalization pipeline accepts them.

## Pyth boundary

The Pyth adapter uses the upgraded Hermes v2 latest-price route, requires a bearer credential,
accepts at most 20 explicit feed IDs, and converts integer price/confidence values using their
signed decimal exponent. Missing feeds, malformed values, insecure remote endpoints, unsuccessful
HTTP responses, missing credentials, and unsafe timeouts fail closed.

The adapter is fixture-validated but cannot be called live until `PYTH_API_KEY` is configured. No
Pyth credential is present in the repository.

## Free historical market-data boundary

The Binance Vision adapter supplies the free historical leg without weakening venue identity. A live
validation imported all 44,747 SOLUSDT aggregate trades from 2021-01-01, retained each raw row, and
produced 44,747 canonical `binance-spot` events. The published archive checksum was
`sha256:9d1ff447070e47d291d0dcd94893e5c8a9433457d3d066be65d4f8881ae08929`. A second import read the
same 44,747 records and inserted zero, demonstrating deterministic IDs and idempotency.

The first durable run completed in approximately 44 seconds on local PGlite (about 1,017 records per
second, inclusive of download, validation, extraction, migrations, raw-object compression, and
canonical persistence). Writes use bounded transactions to avoid per-record commit amplification.

This history is SOL/USDT on Binance, not SOL/USD on Coinbase. Research joins must preserve venue,
quote asset, source timestamp, and ingestion timestamp, and conclusions must be confirmed against
the forward Coinbase dataset. The free history supports return, volume, and volatility research; it
does not reconstruct historical Coinbase order-book state or fill probability.

The continuous collector uses Binance.US for the live public L2 stream because the Coinbase server
reports that its L2 channel requires authentication and the global Binance endpoint is unavailable
from this host's region. Live data is labeled `binance-us-spot`; historical Vision data remains
`binance-spot`. Neither is relabeled as Coinbase.

## Authority

Every connection is read-only. No wallet, signing, transaction submission, exchange order, or
capital allocation capability is introduced.
