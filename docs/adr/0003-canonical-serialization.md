# ADR 0003: Canonical serialization and identifiers

- Status: Accepted for Phase 0; conformance review required in Phase 1
- Date: 2026-09-19
- Security impact: Authorization and reproducibility binding

## Decision

Use lowercase-prefixed ULIDs for domain IDs, UTC ISO-8601 timestamps ending in `Z`, canonical
non-negative decimal strings for atomic units, recursively lexicographically sorted JSON keys, and
SHA-256 hashes prefixed by `sha256:`. Reject undefined and non-finite numbers.

## Consequences

Hashes are stable within the TypeScript implementation. Before cross-language or external signing
use, Phase 1 must select/test a formal canonical JSON standard and Unicode/decimal conformance.
