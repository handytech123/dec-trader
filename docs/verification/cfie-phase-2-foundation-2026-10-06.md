# CFIE Phase 2 foundation report

This report distinguishes measured results from projections and exploratory infrastructure from
confirmatory findings. No validated edge exists.

1. **Branch/revision:** `codex/phase-2-backtest-paper` at `45bea3eb276e8000fa8a71e52577201edbfbaf74`
   before the uncommitted Phase 2 working changes.
2. **Changed scope:** market-research governance/inference, ingestion persistence and benchmark CLI,
   migrations 0051–0052, hourly quality manifests, supervisor storage throttling, dashboard research
   ledger, wallet behavior v2, response-failure classification, and documentation.
3. **Gates:** 58 test files / 235 tests pass. All 52 transactional migrations, 21 package
   boundaries, four fixtures, lint, TypeScript compilation, and the no-live-capability guard pass.
   Coverage is 91.45% statements, 80.07% branches, 96.16% functions and 94.71% lines.
4. **Authority:** `READ_ONLY_RESEARCH; EXECUTION_AUTHORITY_NONE`. No wallet, key, signing,
   submission, order or allocation capability was introduced.
5. **Measured volumes:** 8,170 finalized blocks, 5,429,954 capital events, 472,812 canonical market
   events and 715,037 raw market messages at the captured manifest time.
6. **Maturation:** general outcomes exist at all horizons, but Phase 2 PumpSwap research has 37
   BTC-controlled horizon observations across 10 mature windows. Only one window currently has the
   required trailing baseline. Twenty-four-hour PumpSwap inference is not mature.
7. **Quality:** chain age 6.29 seconds, market age 0.115 seconds, normalization queue 0 pending / 0
   failed. Seventy-three market incidents remained in the trailing hour and require soak follow-up.
8. **Attribution:** owner extraction covered 89.96% of 8,168 archived blocks. The latest rollup had
   5.82% verified endpoint coverage. Unknown remains valid; coverage is not sufficient for broad
   entity-direction conclusions.
9. **Episodes:** 22,185 stored capital-flow episodes. The current PumpSwap inference corpus has
   independent episode counts of 7 (1m), 8 (5m), 10 (15m), 8 (1h) and 4 (6h).
10. **5k vs full episode benchmark:** current samples are below 5,000, so 5k and larger samples use
    the full input. P95 runtime ranged from 1.28 to 4.81 ms with peak heap below 19.6 MB. No mean
    conclusion differed by more than 0.1 percentage point. Dependence was material: overlap was 70%
    at 15m, 87.5% at 1h and 100% at 6h. These are capacity/inference measurements, not findings.
11. **Wallet features:** point-in-time wallet behavior v2 now fails closed below its minimum history
    and computes quantity percentile/z-score, cadence abnormality, dormancy, directional totals, net
    flow, counterparty concentration and novelty using prior evidence only. At the latest rollup,
    20,529 of 100,000 entities (20.529%) cleared the 30-event minimum; 4,656,375 of 6,153,716
    endpoint observations (75.668%) occurred after that history became available. Of eligible
    entities, 18,857 were bidirectional and 20,293 had multiple counterparties. This measures
    feature availability, not predictive value or attribution confidence.
12. **Reaction cohorts:** the current bounded 60-second coverage query found 6,935 reaction
    features, 5,660 with complete displacement/imbalance/depth inputs. The neutral classifier
    assigned 5,145 heavy-selling/limited-downside, 1,210 liquidity-withdrawal, 510 balanced-flow,
    and 70 liquidity-addition records. This pronounced asymmetry requires side-decoding and
    venue-quality falsification before any economic interpretation. PumpSwap conditional reaction
    cohorts remain immature and exploratory.
13. **Explored hypotheses:** six explicitly registered exploratory families consume 6/72 budgeted
    attempts; zero has been tested. Families cover entity direction/magnitude, wallet abnormality,
    flow/market reaction, flow/regime, episode structure, and market-response failure.
14. **Preregistered hypotheses:** the existing frozen PumpSwap protocol remains the only active
    confirmatory protocol. No Phase 2 family has been frozen prematurely.
15. **Corrected development result:** `INSUFFICIENT_DATA`, 37 observations, 99 timestamp trials.
16. **Falsification:** infrastructure is present; no Phase 2 candidate exists to attack.
17. **Rejected hypotheses:** none yet. Migration 0051 adds immutable negative-knowledge storage.
18. **Promotion:** none. Fragility classification and the existing promotion gate remain
    fail-closed. Promotion records are immutable; both application logic and migration 0052 require
    a future-only window, and approval requires an explicitly eligible gate result.
19. **Holdout:** zero accesses; sealed.
20. **Materiality/friction:** no candidate result exists. Positive raw means are not treated as
    edge.
21. **Soak/capacity:** PostgreSQL measured 26 GiB with 32.37 GiB free on the host. The previous
    full-block cadence produced 35,335 compressed raw objects (760 MiB) and 415,398 capital events
    in one hour, consistent with an unsustainable multi-GiB/day drain. Owner extraction was
    throttled to two blocks per five minutes, and the full-block fallback was reduced from two
    blocks per ten seconds to one sampled finalized block per minute. Filtered Helius capture plus
    finalized gap reconciliation is the required continuous architecture; the sampled fallback is
    explicitly not chain-complete. Scheduled supervision was re-registered against the stable system
    PowerShell host after the bundled host failed to reload its credential type data.
22. **Unresolved risks:** limited verified attribution, immature PumpSwap baselines, unresolved
    recent feed-incident rate, no mature 24h PumpSwap cohort, and no off-machine replication
    confirmation.
23. **Next milestone:** measure wallet-v2 population coverage, mature the six exploratory families,
    run their falsification battery, and write negative results to the immutable registry. Do not
    open the holdout unless a candidate independently clears the promotion gate.

Artifacts:

- `artifacts/benchmarks/phase-two-inference-live.json`
- `artifacts/research/phase2-foundation-run.json`
- `artifacts/research/phase2-live-status.json`
- `artifacts/research/phase2-exploratory-ledger.json`
- `artifacts/research/phase2-wallet-coverage.json`

Live dashboard verification at handoff: `/api/phase-two` reported two quality manifests, six
hypothesis attempts, zero rejections and zero promotions. The collector and derivation worker
remained running during the dashboard deployment.
