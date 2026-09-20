# ADR 0001: TypeScript monorepo toolchain

- Status: Accepted
- Date: 2026-09-19
- Security impact: Supply-chain and boundary enforcement

## Decision

Use Node.js 22, pnpm workspaces, strict TypeScript project references, ESLint, Prettier, Vitest, and
GitHub Actions. Installs use a frozen lockfile and ignore dependency lifecycle scripts in CI.
Packages express one-way capabilities: domain has no internal dependencies; strategy SDK cannot
depend on execution contracts. Phase 0 does not install Solana or execution-provider SDKs.

## Consequences

The repository has deterministic dependency resolution and independently testable boundaries.
Production framework and queue choices remain open until their phase.
