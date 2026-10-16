# CFIE public-provider validation — 2026-10-02

## Scope

Two new isolated, read-only validations used Solana's public mainnet RPC, Coinbase Exchange's public
SOL-USD WebSocket, and the configured public Coinbase REST trade source. No credentials, wallets,
keys, signing, transaction submission, orders, or capital authority were present.

## Initial 120-second validation

| Metric                                | Result |
| ------------------------------------- | -----: |
| Coinbase raw frames                   |    407 |
| Coinbase trades                       |    288 |
| Coinbase reconnects / incidents       |  0 / 0 |
| Durably captured Solana blocks        |      7 |
| Normalized capital events             |  5,399 |
| Completed / failed normalization jobs |  7 / 0 |
| Solana completed batches              |      0 |
| Solana collection failures            |      5 |

The collector stored and normalized seven blocks, but four-way block-request concurrency caused HTTP
429 responses before the ten-slot batch completed. Checkpoint advancement correctly remained
fail-closed, and later attempts safely deduplicated stored blocks. Failure reporting was expanded
before the next run.

## Conservative 30-second validation

Configuration changed to two slots per batch and one block request at a time.

| Metric                              |                                        Result |
| ----------------------------------- | --------------------------------------------: |
| Solana polls / completed batches    |                                         4 / 3 |
| Solana blocks                       |                                             6 |
| Solana failures / gaps              |                                         0 / 0 |
| Capital events                      |                                         4,597 |
| Live / final-drain jobs             |                                         5 / 1 |
| Queue after drain                   | 0 pending, 0 processing, 6 complete, 0 failed |
| Coinbase raw frames / trades        |                                     138 / 110 |
| Coinbase connections / reconnects   |                                         1 / 0 |
| Coinbase feed incidents / backfills |                                         0 / 0 |
| Retention deletions                 |                   0, as expected for new data |

This configuration completed cleanly and proves capture, concurrent normalization, final drain,
retention audit, Coinbase REST configuration, and manifest generation work together. It is too
conservative to keep pace with typical Solana slot production: a five-second poll can capture only
two slots while substantially more may finalize.

## Decision

Keep public Solana RPC defaults at two slots per batch and one block request at a time. Do not claim
continuous coverage with that endpoint. A dedicated RPC with documented rate and historical-block
support is required before sustained collection. Coinbase public collection behaved cleanly in both
samples; REST recovery was configured but was not invoked because no trade gap occurred.

## Dedicated-RPC combined validation

A credentialed Helius mainnet endpoint was validated without persisting its credential. A single
block normalized 414 capital events in 3.8 seconds. The subsequent 30-second combined run used two
slots per batch and one block request at a time:

| Metric                           |                                        Result |
| -------------------------------- | --------------------------------------------: |
| Solana polls / completed batches |                                         3 / 2 |
| Solana blocks / capital events   |                                     4 / 2,483 |
| Solana failures / gaps           |                                         0 / 0 |
| Queue after drain                | 0 pending, 0 processing, 4 complete, 0 failed |
| Coinbase raw frames / trades     |                                       54 / 26 |
| Coinbase reconnects / incidents  |                                         0 / 0 |
| Acceptance result                |                                          PASS |
| Post-run operational health      |                                       HEALTHY |

An initial run against a mismatched quiet WebSocket protocol exposed an abort-lifecycle defect: the
stream could remain blocked waiting for its next message after the observation deadline. The stream
now closes the active connection proactively and idempotently when aborted, with a silent-connection
regression test. The corrected Coinbase Exchange endpoint and Helius run exited cleanly.

## Dedicated-RPC 15-minute soak

| Metric                           |                                          Result |
| -------------------------------- | ----------------------------------------------: |
| Solana polls / completed batches |                                         67 / 67 |
| Solana blocks                    |                                             133 |
| Capital events                   |                                          79,361 |
| Solana failures / gaps           |                                           0 / 0 |
| Normalization jobs               | 133 complete, 0 pending, 0 processing, 0 failed |
| Normalization retries            |                                               0 |
| Coinbase raw frames / trades     |                                     1,628 / 729 |
| Coinbase reconnects / incidents  |                                           0 / 0 |
| Acceptance / health              |                                  PASS / HEALTHY |

The run used the same two-slot, single-request profile as the conservative validation. Live
normalization completed 132 blocks and the bounded final drain completed the last block. No raw data
was removed by the seven-day retention pass.

Artifacts are retained under:

- `.atl-data/cfie-provider-validation-20261002`
- `.atl-data/cfie-provider-diagnostic-20261002`
- `.atl-data/cfie-provider-conservative-20261002`
- `.atl-data/cfie-helius-single-block`
- `.atl-data/cfie-helius-combined-20261002`
- `.atl-data/cfie-helius-soak-20261002`
