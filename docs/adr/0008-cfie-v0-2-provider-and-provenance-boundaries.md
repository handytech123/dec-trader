# ADR 0008 CFIE v0.2 provider and provenance boundaries

## Status

Accepted on 2026-09-30.

## Context

CFIE Engineering Specification v0.2 makes Sections 22 through 31 authoritative. It requires
vendor-neutral canonical objects, capability-based provider contracts, immutable raw payloads, and
append-only enrichment claims. The existing repository already supplies strict TypeScript,
PostgreSQL migrations, immutable raw observations, deterministic normalization, fixture-based tests,
and safety gates. Replacing those compatible conventions would add risk without improving the Phase
0 acceptance result.

## Decision

- Keep the existing pnpm monorepo and PostgreSQL migration system.
- Add `@autonomous-trading-lab/provider-sdk` as the vendor-neutral provider-contract boundary.
- Keep raw provider payloads in `raw_observations`; canonical records reference their content hash.
- Store provider-derived interpretations as immutable enrichment claims instead of overwriting
  facts.
- Use relational entity and relationship tables until measured query requirements justify a graph
  database.
- Keep the existing capital-flow feature implementation fixture-driven and dormant during Phase 0.
  No live collector, paid provider, credential, or trading authority is added.

## Consequences

Adapters may depend on provider SDK contracts and translate recorded responses into canonical
objects. Core domain, feature, hypothesis, and evidence code must not import vendor response types.
Provider failure may reduce enrichment availability but cannot mutate accepted raw or canonical
records.
