# Trust boundaries

1. Public/provider data to ingestion: hostile content, malformed numbers, stale/replayed responses.
2. Stored observations to strategies: provenance and point-in-time integrity.
3. Strategies to proposal ledger: strict schema prevents authority smuggling.
4. Proposal/quote to risk: deterministic inputs and immutable rule versions.
5. Execution to signer: strongest boundary; exact authorization and independent parsing required.
6. Signer to provider/chain: destination, program, blockhash, fee, and balance-delta validation.
7. Owner to control plane: authentication, CSRF protection, audit events, time-limited activation.
8. AI/external text to system: untrusted data only; never instructions or tool authority.

Phase 0 implements contract and repository controls for boundaries 3–5 but no operational path.
