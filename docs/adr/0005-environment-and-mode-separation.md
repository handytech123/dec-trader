# ADR 0005: Environment and mode separation

- Status: Accepted
- Date: 2026-09-19
- Security impact: Prevent accidental live activation

## Decision

Development, paper, and live are distinct deployment environments. System mode is a separate
authoritative state. Phase 0 runtime configuration permits only offline, network-disabled operation;
the schema rejects the live environment and `LIVE_ARMED`. No credential or wallet fields exist.
Future live deployment cannot share runtime, filesystem, or environment with dashboard or AI code.

## Consequences

Later phases must extend configuration through a reviewed ADR and tests. Restart never restores live
authorization, and mode is never inferred from environment names.
