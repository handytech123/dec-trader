# Initial threat model

- Version: 1.0
- Scope: Phase 0 repository plus the target architecture described by the engineering specification
- Method: STRIDE by trust boundary, augmented with financial safety and research-integrity threats
- Review triggers: new provider, new service boundary, custody design, live network access, new
  signer capability, risk-limit change, security incident, or phase exit

## Assets and security objectives

| Asset                   | Objective                                                                   |
| ----------------------- | --------------------------------------------------------------------------- |
| Future wallet keys      | Never leave isolated signer/secret store; never enter source, logs, prompts |
| Execution authorization | Authentic, exact, short-lived, replay-resistant, fail-closed                |
| Funds and balances      | No arbitrary transfers; reconcile against chain authority                   |
| Risk policy/mode        | Owner-controlled, versioned, deterministic, audited                         |
| Observations/features   | Provenance, freshness, point-in-time integrity, reproducibility             |
| Proposals/events/ledger | Immutable attribution and idempotency                                       |
| Owner identity          | Strong authentication and auditable administrative actions                  |
| Research results        | No leakage, survivorship bias, cost omission, or mode mixing                |

## Actors

The human owner and narrowly scoped services are trusted only for their documented responsibilities.
Providers, RPC nodes, tokens, metadata, websites, strategy authors, dependencies, fixtures, and AI
outputs are untrusted. A compromised internal service is assumed possible; boundaries must limit it.

## Threat register

| ID  | Boundary / STRIDE        | Threat                                                    | Required mitigation                                          | Phase 0 control / later owner       |
| --- | ------------------------ | --------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------- |
| T01 | Provider / Spoofing      | Forged or conflicting market data                         | Provenance, quorum/tolerance, freshness, fail closed         | Normalized ports; Phase 1/3         |
| T02 | Provider / Tampering     | Quote changes after approval                              | Bind proposal/quote/build/simulation hashes; expire          | Contract + ADR; Phase 4             |
| T03 | Proposal / Elevation     | Strategy smuggles wallet, route, destination, or slippage | Strict schema, reject unknown fields                         | Implemented and tested              |
| T04 | Signer / Elevation       | Generic signing or hidden instruction drains funds        | Narrow API, independent parse, program/pattern allowlist     | Documented/guarded; Phase 5         |
| T05 | Signer / Spoofing        | Destination account substitution                          | Re-derive wallet-owned accounts and verify deltas            | Phase 5 adversarial test            |
| T06 | Workflow / Replay        | Duplicate proposal or authorization                       | Idempotency, nonce consumed before signature, CAS state      | Types now; Phase 4/5                |
| T07 | Workflow / Repudiation   | Missing/rewritten decisions                               | Append-only events with actor, hashes, rule evidence         | Envelope now; Phase 1/4             |
| T08 | Workflow / DoS           | Timeout interpreted as success                            | Timeout is rejection/UNKNOWN; reconcile before retry         | State contract now; Phase 4         |
| T09 | Token / Tampering        | Decimal spoofing or unsupported extension                 | On-chain metadata, exact atomic math, reject unknown         | Atomic types now; Phase 4/5         |
| T10 | AI / Elevation           | Prompt injection changes policy or invokes tools          | External text is data; AI has no mutation/signing path       | Boundary docs; later tests          |
| T11 | Secrets / Disclosure     | Credential leaks through code/log/fixture/crash           | External secret store, redaction, scanners, fixture rules    | Ignore rules, CI/hook, fixture scan |
| T12 | Supply chain / Tampering | Malicious dependency/action                               | Lockfile, pinned actions, review, audits, no install scripts | CI and dependency controls          |
| T13 | Mode / Elevation         | Restart or config silently arms live mode                 | Authoritative mode, lease, owner action; reject live now     | Config schema; later persistence    |
| T14 | Accounting / Tampering   | App state hides wallet divergence                         | Chain reconciliation, double-entry invariants, halt          | Phase 4/5                           |
| T15 | Research / Tampering     | Future leakage or result cherry-picking                   | Point-in-time boundaries, immutable failed runs              | Phase 1/2                           |
| T16 | Availability / DoS       | DB/audit failure allows trades                            | Halt entries when durability/audit unavailable               | Phase 4/5                           |
| T17 | Owner / CSRF             | Unauthorized live activation or limits                    | Strong auth, CSRF, challenge, audit, expiry                  | Phase 3/5 decision                  |
| T18 | Wallet / Tampering       | Airdrop becomes collateral/sell target                    | Quarantine unsolicited assets                                | Phase 4/5                           |

## Abuse cases to test before live readiness

- Replay an authorization and duplicate a provider response.
- Substitute destination, mint, fee payer, blockhash, instruction, or route program.
- Add a hidden instruction after inspection or change a quote after risk approval.
- Supply malicious metadata, extreme decimals, stale data, conflicting RPC results, or clock drift.
- Crash after every state transition and prove that recovery never duplicates a trade.
- Remove audit durability, reconciliation, or provider availability and prove entry fails closed.

## Phase 0 residual risk

The repository guard is defense in depth, not a proof that later commits cannot add live capability.
Git hooks are bypassable and CI repository settings are external to source control. Formal canonical
JSON conformance, protected-branch enforcement, CODEOWNERS, artifact signing, and external security
review remain required in their designated phases. No financial asset or secret exists in Phase 0.
