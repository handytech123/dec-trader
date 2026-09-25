# Autonomous Trading Laboratory

A safety-first platform for reproducible trading research. The authoritative requirements and safety
contract are in [`docs/ENGINEERING_SPEC.md`](docs/ENGINEERING_SPEC.md).

## Safety status

The laboratory now supports offline deterministic replay, cost-aware backtesting and paper fills,
real DEX market-data collection, point-in-time feature snapshots, forward-outcome labeling, and
read-only Solana mint safety assessment. It intentionally has no wallet, signing,
transaction-building, transaction-submission, or live-trading implementation. Tests remain
network-independent; real provider access occurs only through explicit collection commands.

## Development

Requirements: Node.js 22.17 or later and pnpm 11.5.1.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:coverage
```

Research operations:

```sh
pnpm discover:solana
pnpm collect:dex -- --watchlist .atl-data/solana-research-watchlist.json --top-pools 3
pnpm inspect:safety
pnpm inspect:routes
pnpm inspect:integrity
pnpm shadow
pnpm report:data
```

`report:data` labels assets only as research-eligible or excluded. It does not emit investment
advice or live orders. A strategy cannot be described as validated until sufficient forward labels
exist and its locked rules pass walk-forward evaluation including costs and a no-trade baseline.

The design package, security documentation, ADRs, and phase acceptance mappings live under
[`docs/`](docs/).
