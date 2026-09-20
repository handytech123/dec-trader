# ADR 0004: Quote, risk, simulation, and authorization flow

- Status: Accepted
- Date: 2026-09-19
- Security impact: Governing transaction authorization boundary

## Context

The specification's provider interface requests a quote from an approved intent, while final risk
approval requires quote and simulation evidence.

## Decision

A narrow `QuoteRequest` carries no authorization. Risk precheck after quoting allows construction
but not signing. After local inspection and preflight simulation, the deterministic risk engine may
issue final short-lived `ExecutionAuthorization` bound to exact hashes and limits. The signer must
independently parse and enforce policy; upstream inspection evidence is not trusted.

## Consequences

The internal state machine adds `RISK_PRECHECKED`, `SIMULATED`, and `AUTHORIZED`. This clarifies the
specified workflow without permitting a bypass. Any future change requires owner/security review.
