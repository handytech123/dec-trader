# CFIE entity intelligence milestone — 2026-10-03

## Implemented

- Evidence-backed address records with validity and retrieval timestamps.
- Point-in-time resolution that cannot use labels learned after an event.
- Fail-closed conflict detection for overlapping provider claims.
- Exchange, bridge, protocol, and pool inflow/outflow classification.
- Unknown-to-unknown and ambiguous classifications remain explicit.
- Atomic registry imports with a 100,000-record safety bound.
- Non-mutating registry audits for overlap conflicts and source diversity.
- Registry-quality and attribution-coverage metrics in the CFIE report and dashboard.
- Wallet behavior features computed from strictly prior observations:
  - transfer quantity Z-score;
  - seconds since prior activity;
  - prior 24-hour event frequency;
  - new-counterparty detection;
  - immutable evidence-event identity list.
- Bounded CLI and local HTTP inspection interfaces.
- Primary-source HTTPS connector with address-in-document verification.
- Immutable, content-addressed source snapshots retaining the exact downloaded evidence.
- Idempotent maintenance sync: unchanged source evidence creates no duplicate records.

## Initial primary registry

The first bounded sync verified and imported seven mainnet program addresses from four official
sources: Solana documentation, Wormhole contract-address documentation, Jupiter's official
instruction-parser repository, and Jupiter's official Lend address documentation. The audit found no
conflicting overlaps. Every record remains flagged as single-source evidence until an independent
authoritative source corroborates it.

## Scientific boundary

These features describe observed behavior. They do not assert ownership for unknown addresses and do
not imply that an attributed flow predicts price. Predictive value remains subject to the frozen
research protocol, chronological holdout, multiple-testing correction, and falsification controls.

## Authority boundary

The implementation is read-only. It has no wallet secret, transaction signing, transaction
submission, exchange-order placement, or autonomous capital-allocation capability.
