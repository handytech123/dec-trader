# CFIE demonstration guide

CFIE is a read-only capital-flow research system. The demonstration proves collection, point-in-time
evidence, deterministic analysis, operational supervision, and sealed-holdout controls. It does not
place orders, connect wallets, sign transactions, or allocate capital.

## Live demonstration

1. Run `pnpm operations:supervise` from the repository root.
2. Open `http://127.0.0.1:4173` on the host, or the host's LAN address from a phone on the same
   network.
3. Confirm the Live Operations cards show the supervisor and collector running, available disk
   space, separately supervised derivation, hourly development research, and the most recent
   verified backup.
4. Inspect Capital Flow for normalized Solana events, Coinbase/Binance market evidence,
   point-in-time reference prices, entity attribution, and PumpSwap windows.
5. Confirm the protocol panel says `SEALED`. Development analysis must not inspect the holdout.

## Deterministic offline demonstration

Run `pnpm demo:cfie`. This builds a fixture-backed research database and starts the dashboard
without requiring exchange keys, wallet credentials, or transaction authority.

## External validation package

Run `pnpm validation:package`. The generated ZIP under `artifacts/validation` contains source,
tests, migrations, configuration, and documentation plus a SHA-256 manifest. It excludes local
databases, backups, logs, attachments, build products, environment files, and protected secrets.

## Verification commands

- `pnpm check` — formatting, lint, build, tests, boundaries, fixtures, migrations, safety scan.
- `pnpm backup:verify` — manifest/hash/archive/data-stream validation for the newest backup.
- `pnpm operations:status` — database-side collector and feed status.

All results are research evidence only. Economic usefulness remains unproven until a preregistered
development candidate survives falsification and a separately authorized sealed-holdout test.
