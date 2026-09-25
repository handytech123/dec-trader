# Ingestion worker

Research-only capture worker for exact-address DEX market observations. Strategies consume only the
normalized portion of a capture; the complete provider payload is retained for audit and future
feature extraction.

The first adapter uses DEX Screener's public token-pairs endpoint. It never searches by symbol. A
returned pair is accepted only when the configured mint exactly matches its base or quote token
address on Solana. Pools are ranked deterministically by reported USD liquidity.

## Run a capture

1. Copy `config/solana-watchlist.example.json` to a local file outside source control or edit a
   private copy with exact token mint addresses.
2. Build and collect:

```sh
pnpm collect:dex -- --watchlist C:/path/to/watchlist.json
```

The default append-only spool is `.atl-data/dex-observations.jsonl`; the durable
PostgreSQL-compatible PGlite database is `.atl-data/research-db`. Override them with `--output` and
`--database`. Each spool line contains a hash-bound raw observation and a normalized research
observation. The spool is a recovery buffer; the database is the local authoritative research store
and uses the repository's versioned PostgreSQL migrations.

Useful options:

```text
--top-pools 3       Maximum exact-match pools retained per mint (1-20)
--timeout-ms 10000  Provider timeout (1000-30000)
```

No wallet, signing, quote execution, or transaction submission capability exists in this worker.

## Generate the initial research universe

The discovery command joins CoinGecko's Solana-ecosystem market list to its platform-aware coin
list, then writes exact Solana mint addresses. Defaults select up to 40 non-stablecoin assets with
market caps from $10M to $2B and at least $1M reported 24-hour volume:

```sh
pnpm discover:solana
pnpm collect:dex -- --watchlist .atl-data/solana-research-watchlist.json
```

Discovery is candidate generation, not token approval. On-chain verification and local liquidity
gates remain required before an asset can become strategy-eligible.
