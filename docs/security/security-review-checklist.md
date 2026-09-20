# Security review checklist

- [ ] Changes preserve every governing invariant in Sections 4 and 5.
- [ ] New inputs use strict runtime schemas and fail closed.
- [ ] No strategy or AI boundary gained wallet, provider, signer, or administrative authority.
- [ ] No generic signing, arbitrary transfer, or raw-transaction interface exists.
- [ ] Authorization remains exact, short-lived, replay-resistant, and independently revalidated.
- [ ] Secrets and signed transactions cannot enter logs, fixtures, examples, or prompts.
- [ ] State transitions, idempotency, unknown outcomes, and crash recovery are tested.
- [ ] Provider-specific fields remain inside adapters.
- [ ] New threat and trust-boundary changes are recorded in this model and an ADR.
- [ ] Owner approval exists for custody, key handling, transfers, live activation, or limit changes.
