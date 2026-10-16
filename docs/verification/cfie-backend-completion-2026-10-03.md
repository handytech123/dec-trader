# CFIE backend completion milestone — 2026-10-03

## Outcome

The read-only CFIE backend now closes the collection-to-research visibility loop. It can capture
full finalized Solana blocks or bounded filtered transaction notifications, preserve exact source
payloads, reconcile confirmed notifications against finalized blocks, normalize capital events,
apply evidence-backed point-in-time entity labels, join market observations without future leakage,
label forward outcomes, and expose operational and research state through the local API/dashboard.

## Added in this milestone

- Immutable, versioned verified-address registry with evidence hashes and validity intervals.
- Safe registry import command; unknown addresses remain unknown.
- Helius-compatible `transactionSubscribe` request and notification contracts.
- WSS-only, explicit-opt-in filtered collector with message/time limits, acknowledgement checks,
  bounded exponential reconnects, lossless raw payloads, and durable checkpoints.
- Finalized-RPC reconciliation queue and retry-safe bounded worker.
- Append-only reconciliation evidence and migration-backed indexes.
- Dashboard/API reporting for attribution coverage, filtered capture finality, research-run status,
  and point-in-time directional outcome cohorts.
- PostgreSQL URL support in the dashboard, security headers, and an operational health endpoint.
- Deterministic offline demonstration coverage for verified attribution and stream reconciliation.

## Verification

- The deterministic demo produced two capital events, three market events, one evidence packet, two
  verified address records, one filtered transaction, and one finalized reconciliation.
- The running dashboard returned HTTP 200 for the application, CFIE report, and health endpoint.
- The demo report showed 50% verified endpoint coverage because two fixture endpoints are explicitly
  verified and two are deliberately unknown.
- Live execution remains absent: no wallet credentials, signing, transaction submission, exchange
  order placement, or autonomous capital allocation exists in these paths.

## Remaining external validation

The implementation is ready for a bounded enhanced-WebSocket pilot. That pilot still depends on the
configured provider account allowing `transactionSubscribe`. Economic usefulness remains unproven
until enough uninterrupted observations mature and the preregistered holdout analyses pass.
