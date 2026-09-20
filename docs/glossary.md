# Domain glossary

- **Authorization:** Short-lived deterministic permission bound to one proposal, quote, inspected
  swap, simulation, wallet policy, network, amount, risk profile, nonce, and expiry.
- **Evaluation mode:** Strategy execution context: `BACKTEST`, `SHADOW`, `PAPER`, or `LIVE`.
- **Execution:** Persisted workflow for one proposal. Unknown outcomes remain unresolved and are not
  retried automatically.
- **Fixture:** Synthetic or sanitized recorded provider input with provenance metadata; never a
  credential or signed transaction.
- **Proposal:** Immutable strategy output. It carries economic intent but no wallet, program, route,
  destination, transaction, signing, or policy-override authority.
- **Risk precheck:** Non-authorizing eligibility evidence produced before transaction construction.
- **Strategy version:** Immutable content-addressed source, configuration, feature schema, and model
  artifact combination.
- **System mode:** Authoritative deployment state: `OFFLINE_RESEARCH`, `SHADOW`, `PAPER`,
  `LIVE_ARMED`, or `HALTED`.
- **Unknown:** Execution outcome not yet proven by chain reconciliation. It never permits a
  duplicate.
- **Wallet policy:** Versioned signer restrictions; it is not wallet key material.

Amounts use integer atomic units at boundaries. Prices, ratios, and currency values use explicit
base-10 decimals. UTC timestamps are normalized with a trailing `Z`.
