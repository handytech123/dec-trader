# Codex Kickoff Prompt

Use this message when starting implementation with Codex:

> We are building the Autonomous Trading Laboratory described in `ENGINEERING_SPEC.md`. Treat that document as the source of truth and safety contract. Begin with Phase 0 only. Do not implement live trading, create or fund a wallet, request private keys, add production credentials, or weaken any governing invariant.
>
> First inspect the repository and report any conflicts with the specification. Then propose a short Phase 0 implementation plan with concrete deliverables, tests, and acceptance criteria. After approval, scaffold the project, CI, architecture decision records, threat model, typed domain contracts, and secret-scanning protections. Keep provider integrations behind interfaces and use fixtures/mocks.
>
> For every change, explain which Phase 0 exit criterion it satisfies. Stop and ask before making any decision involving custody, live activation, key handling, maximum loss, external transfers, or a change to Sections 4 or 5. Never place a seed phrase or private key in chat, source control, configuration examples, logs, or prompts.

## First expected response from Codex

Codex should return:

1. Repository assessment.
2. Phase 0 plan and file tree.
3. Decisions that require owner input versus safe defaults.
4. Verification plan.
5. Explicit confirmation that no live-trading capability will be added in Phase 0.

