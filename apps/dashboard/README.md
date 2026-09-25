# DEX research dashboard

Read-only owner interface for the local research database. It exposes no wallet, signing, funding,
or transaction-submission capability and binds to `127.0.0.1` by default.

Run `pnpm dashboard` from the repository root, then open `http://127.0.0.1:4173`.

The browser refreshes the research report every 15 seconds from `.atl-data/research-db`.
