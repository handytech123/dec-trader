# CFIE Nansen + CoinGlass enrichment pilot

1. **Branch/revision:** `codex/phase-2-backtest-paper`; working tree remains uncommitted.
2. **Scope:** vendor-isolated Nansen/CoinGlass adapters, canonical enrichment package, migration
   0053, bounded pilot CLI, provider-status API/GUI, encrypted local setup helpers and tests.
3. **Environment names:** `NANSEN_API_KEY`, `COINGLASS_API_KEY`. Values were never printed or
   committed. DPAPI files outside Git are used only to inject these variables for local runs.
4. **Capability manifests:** two immutable manifests persisted for API v1/v4 bounded probes.
5. **Access:** Nansen `smart-money/holdings` is available. CoinGlass
   `futures/open-interest/exchange-list` authenticated but returned provider code 401,
   `Upgrade plan`; it is recorded as restricted rather than as zero or neutral data.
6. **Usage:** bounded provider calls are recorded immutably. CoinGlass is now disabled by default
   and made zero requests during the Nansen-first canonicalization run. Rate metadata was not
   exposed. No automated upgrade or payment occurred.
7. **Cache/budgets:** generic runtime implements TTL cache, duplicate coalescing, per-minute and
   daily request ceilings, concurrency bounds and a failure circuit breaker. Retry-after/backoff is
   not yet connected to scheduled collection.
8. **Nansen pilot:** one deterministic Solana holdings page ordered by `value_usd DESC` with a
   ten-row limit; response retained as hash plus request metadata only. The decoder validates every
   published response field and fails closed on schema drift.
9. **CoinGlass pilot:** SOL open-interest capability was restricted; zero market observations were
   accepted.
10. **Point-in-time:** 50 canonical Nansen observations were persisted in PostgreSQL: five metrics
    for each of ten holdings. They become eligible only from their retrieval timestamp. Schema and
    database reject observations marked both point-in-time eligible and retrospective-only.
11. **Failure tests:** HTTP failures, HTTP-200 plan restrictions, unsafe hosts, invalid symbols,
    malformed configuration, cache/coalescing and retrospective leakage are covered.
12. **Gates:** 61 test files / 245 tests pass; 53 transactional migrations, 24 package boundaries,
    four fixtures, lint and compilation pass.
13. **Authority:** `READ_ONLY_RESEARCH`; execution authority remains `NONE`.
14. **Ablation:** A/B/C/D population-equality guard and immutable manifest persistence exist for
    `CFIE_BASE`, `CFIE_NANSEN`, `CFIE_COINGLASS`, and `CFIE_NANSEN_COINGLASS`. The readiness CLI
    uses identical development populations, explicit missingness, and never accesses holdout data.
15. **Cohorts:** the first cohort is `ACCUMULATING`. It will become manifest-eligible at 30 capital
    events observed after Nansen availability with matured 15-minute outcomes.
16. **Interpretation:** exploratory infrastructure only. No edge or trade recommendation exists.
17. **Limitations:** holdings are token-level aggregate Smart Money measurements rather than
    wallet-level identities. CoinGlass remains unavailable under the current plan. No provider
    feature has demonstrated predictive or economic value.
18. **Next run:** allow post-enrichment events and their 15-minute outcomes to mature, persist the
    first equal-population manifest, then compare development results with and without Nansen. Do
    not open the holdout.
