# Autonomous Trading Laboratory

A safety-first platform for reproducible trading research. The authoritative requirements and safety
contract are in [`docs/ENGINEERING_SPEC.md`](docs/ENGINEERING_SPEC.md).

## Safety status

Phase 1 adds an offline data foundation and deterministic replay. The repository intentionally has
no wallet, signing, transaction-building, RPC-submission, or live-trading implementation. Provider
examples are synthetic fixtures, and tests run without network access.

## Development

Requirements: Node.js 22.17 or later and pnpm 11.5.1.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:coverage
```

The design package, security documentation, ADRs, and phase acceptance mappings live under
[`docs/`](docs/).
