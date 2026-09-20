# Secret handling policy

Phase 0 requires no credentials. Never put a seed phrase, private key, wallet file, API token,
authorization header, signed transaction, or production endpoint in source, chat, prompts, fixtures,
logs, analytics, crash dumps, tickets, or `.env.example`.

- `.env` variants and common key/wallet files are ignored, but ignore rules are not protection.
- CI secret scanning is authoritative; the local pre-commit hook is early feedback.
- Suspected exposure is treated as compromise: revoke/rotate externally, preserve incident evidence,
  remove the secret from active history, and document the event without reproducing the secret.
- Later environments use separate identities and an external secret manager with least privilege.
- Redaction must operate before telemetry leaves a process.

No allowlist may suppress a verified secret merely to make CI pass.
