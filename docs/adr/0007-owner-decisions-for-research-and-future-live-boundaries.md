# ADR 0007: Owner decisions for research and future live boundaries

- Status: Accepted
- Date: 2026-09-25
- Owners: project owner and engineering
- Security impact: Provider trust, custody, access control, research validity, and accounting

## Context

Section 22 of the engineering specification requires the owner to decide the repository identity,
provider approach, future swap API and signer boundaries, dashboard exposure, historical-data
sources, wallet-quality methodology, and tax export requirements before Phase 1 can formally exit.
The owner approved the researched recommendation bundle on 2026-09-25.

This ADR records design choices. It does not authorize credentials, wallet creation or funding,
signing, transaction submission, live activation, or progression past a phase's exit gate.

## Decision

1. The project name is **dec-trader**, hosted at `https://github.com/handytech123/dec-trader.git`.
2. Helius is the preferred Solana RPC/indexing provider for later authenticated ingestion. A
   standard Solana JSON-RPC endpoint is the independent fallback and disagreement/health signal.
   Provider retention and paid tier are selected only after measured shadow-run volume establishes
   the required capacity. Credentials must enter through an approved local secret store and never
   through prompts, source, fixtures, logs, or client applications.
3. The future execution spike targets Jupiter Swap V2's Router/instruction path. The system must
   decode and independently validate every instruction; provider output is never signer authority.
   Deprecated Ultra endpoints and opaque managed execution are not the default path.
4. If Phase 5 is reached, Turnkey is the preferred managed policy-key backend behind the project's
   isolated signer service. The signer remains fail-closed and independently enforces program, mint,
   account-ownership, amount, expiry, nonce, and balance-delta policy. This choice does not
   provision a wallet or authorize production signing.
5. The dashboard is local-only by default and binds to loopback. Any remote owner access uses
   Tailscale Serve with owner-only access policy; it is not exposed directly to the public internet.
6. Helius archival data is the preferred canonical raw historical source. The laboratory derives and
   versions point-in-time liquidity and holder snapshots internally, retaining provenance and
   avoiding present-day metadata leakage into historical samples. A second source may be used for
   comparison but cannot silently overwrite canonical observations.
7. Wallet-quality scoring is transparent and versioned: 30% net expectancy, 20% independent sample
   adequacy, 15% drawdown, 15% execution realism, 10% token-risk quality, and 10% cluster
   independence. Eligibility requires at least 50 matured observations over at least 90 days. The
   score excludes suspected self-trades, shared-funding clusters, deployer/insider clusters,
   transfer-only activity, unsellable assets, and outcomes that cannot be reconstructed with
   contemporaneous liquidity and costs. Any weight, threshold, or exclusion change creates a new
   methodology version and is evaluated out of sample.
8. Accounting exports are immutable and reproducible. Provide a Form 8949-compatible disposal CSV,
   raw acquisition/disposal/fee records, provenance hashes, and a reconciliation manifest. FIFO is
   the default reporting view; specific-identification lots are optional only when lot identity is
   recorded contemporaneously. Tax output is an export aid, not tax advice.

## Consequences

Phase 1's owner-decision gate is satisfied. Provider integrations must remain mock- and
fixture-driven in automated tests. Phase 3 still requires a measured seven-day shadow run with
reconciled completeness. Phase 5 still requires external review, and Phase 6 still requires the
owner's live-activation checklist and explicit funding decision.

## Alternatives considered

- QuickNode as the primary provider: retained as a future alternative if measured reliability,
  coverage, or cost is better during a controlled evaluation.
- A local raw private key: rejected as the preferred production design because managed policy
  controls and auditability better match the required isolation boundary.
- Public dashboard hosting: rejected because it unnecessarily expands the attack surface.
- Opaque provider-computed historical features: rejected because point-in-time provenance and
  leakage controls cannot be independently demonstrated.

## Revisit triggers

- Provider reliability, retention, or total cost misses a documented service target.
- Jupiter or Turnkey changes or deprecates the selected interfaces or security model.
- Tailscale access cannot enforce the required owner-only boundary.
- Wallet-quality validation detects cluster manipulation or unstable out-of-sample behavior.
- Applicable tax or recordkeeping requirements change.
