# Data-flow and classification

```mermaid
flowchart TD
  U["Untrusted provider payload"] --> N["Validate and normalize"]
  N --> O["Immutable observation"]
  O --> F["Point-in-time feature snapshot"]
  F --> S["Pure strategy evaluation"]
  S --> P["Strict proposal schema"]
  P --> Q["Non-authorizing quote request"]
  Q --> R["Risk precheck"]
  R --> B["Build, inspect, and simulate"]
  B --> A["Exact short-lived authorization"]
  A --> K["Independent signer policy check"]
  K --> C["Submission and reconciliation"]
```

| Flow               | Classification      | Rule                                              |
| ------------------ | ------------------- | ------------------------------------------------- |
| Provider input     | Untrusted           | Preserve provenance; validate before use          |
| Features/proposals | Integrity-sensitive | Version, hash, append-only evidence               |
| Risk evidence      | Security-critical   | Deterministic, complete rule evidence             |
| Authorization      | Restricted          | Exact binding, nonce, short expiry                |
| Key material       | Secret              | Signer boundary only; never logs/prompts/database |
| Audit events       | Security-critical   | Append-only corrections, durable before live use  |

Phase 0 stops at contracts and synthetic fixtures. The downstream arrows describe future gated work.
