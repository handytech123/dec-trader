# Architecture context

```mermaid
flowchart LR
  Owner["Human owner"] --> Control["Control plane"]
  Sources["Market and chain sources"] --> Ingestion["Ingestion boundary"]
  Ingestion --> Store["Versioned observations and features"]
  Store --> Strategy["Pure strategy boundary"]
  Strategy --> Ledger["Immutable proposal ledger"]
  Ledger --> Risk["Deterministic risk boundary"]
  Risk --> Execution["Execution orchestrator"]
  Execution --> Signer["Isolated policy signer"]
  Signer --> Chain["Solana provider and chain"]
  Chain --> Reconcile["Reconciliation and accounting"]
  Reconcile --> Store
  Owner --> Signer
```

Only the deterministic risk engine may create an execution authorization. Only the isolated signer
may access future key material. Neither exists as an operational component in Phase 0.
