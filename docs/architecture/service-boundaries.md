# Service boundaries

| Boundary       | Owns                                          | Must not possess                            |
| -------------- | --------------------------------------------- | ------------------------------------------- |
| Ingestion      | Raw payload provenance, normalization         | Signer access, trade authority              |
| Feature        | Versioned point-in-time features              | Future observations, signer access          |
| Strategy       | Pure evaluation and proposals                 | Wallets, providers, admin DB, execution     |
| Risk           | Deterministic rules and authorization         | Key material, arbitrary transaction signing |
| Execution      | Persisted orchestration                       | Policy override or key material             |
| Signer         | Independent policy validation and future keys | Research/LLM/dashboard runtime              |
| Reconciliation | Chain observations and accounting comparison  | Signing authority                           |
| Control plane  | Versions, modes, owner actions                | Wallet keys or direct submission            |

All mutations require correlation and idempotency identities, timestamps, schema versions, and an
authenticated actor when administrative. Provider-specific data terminates at adapter boundaries.
