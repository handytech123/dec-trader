# Phase 1 verification report

- Date: 2026-09-19
- Status: Complete
- Scope: Data foundation and deterministic replay

## Acceptance mapping

| Requirement                 | Evidence                                                      | Verification         |
| --------------------------- | ------------------------------------------------------------- | -------------------- |
| Normalized observations     | Raw/market schemas and hash-bound normalizer                  | Normalization tests  |
| Provider fixtures           | Synthetic raw, normalized, quote, and failure fixtures        | Fixture scanner      |
| Feature definitions         | Immutable definition/snapshot schemas and calculators         | Point-in-time tests  |
| Immutable strategy versions | Content-addressed schema, registry, and DB trigger            | Mutation tests       |
| Experiment registry         | Content-addressed backtest experiment schema/registry         | Registry tests       |
| PostgreSQL foundation       | Transactional migration with exact numeric types and indexes  | Migration verifier   |
| Deterministic replay        | Stable sorting, boundaries, seed/input/proposal/replay hashes | Replay tests         |
| Identical-input exit        | Input permutation produces byte-identical result              | Reproducibility test |
| No later-phase capability   | Existing prohibited-capability guard                          | `pnpm check:no-live` |

## Owner decisions

- RPC/indexing provider and retention/cost profile.
- Historical point-in-time liquidity and holder-data sources.
- Exact wallet-quality methodology and manipulation controls.
- Tax-lot/export requirements.

The owner approved the researched recommendation bundle on 2026-09-25. ADR 0007 records every
Section 22 decision and preserves the later credential, custody, external-review, shadow-run, and
live-activation gates.

## Results

- Frozen install with dependency lifecycle scripts disabled: passed.
- Format, ESLint, and strict TypeScript build: passed.
- Original Phase 1 tests: 46 passed across 7 files. Repository regression suite on 2026-09-25: 75
  passed across 13 files.
- Runtime coverage: 94.4% statements, 84.9% branches, 88.23% functions, 95.79% lines.
- Deterministic replay: identical recorded inputs in different input order produced identical
  proposals, input hashes, proposal hashes, and replay hashes.
- Point-in-time boundary: future timestamp and slot observations were excluded.
- PostgreSQL migration: executed successfully in PGlite; published-record mutation trigger rejected
  an update as designed.
- Workspace boundary check: 6 packages passed.
- Synthetic fixture validation: 4 files passed.
- Static migration validation: 1 transactional migration passed.
- Prohibited-live-capability guard: passed.
- Dependency audit at moderate severity: no known vulnerabilities.

No wallet, key generation, signing, transaction building, RPC submission, production endpoint,
provider credential, live ingestion, paper broker, or live-trading implementation was added. Phase 2
has not begun.
