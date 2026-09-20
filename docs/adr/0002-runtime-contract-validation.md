# ADR 0002: Runtime-validated contracts

- Status: Accepted
- Date: 2026-09-19
- Security impact: Reject malformed or authority-bearing input

## Decision

Use strict Zod schemas at every external, service, fixture, and persistence boundary and infer
TypeScript types from them. Security-sensitive objects reject unknown fields. Strategy proposals
cannot contain wallet addresses, transactions, programs, destinations, or slippage overrides.

## Consequences

Static and runtime definitions remain aligned. Schema changes require versions and compatibility
tests before persisted or distributed use.
