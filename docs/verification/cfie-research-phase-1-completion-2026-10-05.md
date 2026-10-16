# CFIE Research Phase 1 Completion Report

Generated: 2026-10-05 Authority: `READ_ONLY_RESEARCH`

## Executive result

The Phase 1 research platform is implemented, deployed, collecting live data, and producing
reproducible development-only research packets. No hypothesis has yet demonstrated an economically
material edge. The holdout has never been opened, and the repository has no wallet, signing,
transaction-submission, exchange-order, withdrawal, or autonomous capital-allocation authority.

The remaining work is primarily data maturation and evidence quality, not missing trading
functionality. In particular, no 24-hour forward outcomes have matured, 1-hour and 6-hour
reaction/outcome pairs remain sparse, and provider sequence gaps currently keep operational health
in a degraded state even though live chain and market feeds remain fresh.

## Revision and worktree

- Branch: `codex/phase-2-backtest-paper`
- Current revision: `45bea3eb276e8000fa8a71e52577201edbfbaf74`
- Merge base with `origin/main`: `7a12e51ce2100f7887c1c0bd4e17eb30b243d21b`
- The worktree contains the complete uncommitted CFIE implementation and generated research
  artifacts. It was intentionally not reset or committed as part of this verification run.

## Implemented platform

- Canonical schemas and deterministic content-addressed identifiers
- Solana block collection, durable normalization queue, idempotent capital-event persistence, and
  restart-safe leases
- Coinbase public trades and Binance.US trades plus sequence-aware Level-2 snapshots
- Multi-venue reference-price construction with freshness, spread, disagreement, and point-in-time
  safeguards
- Forward outcomes at 1m, 5m, 15m, 1h, 6h, and 24h when data are mature
- Capital-flow episode algorithm v2, source/destination entity context, direction, attribution
  evidence, and quality flags
- Point-in-time entity attribution that preserves unknown identities
- Market-reaction features, wallet-history features, BTC-relative outcomes, conditional cohorts, and
  market regimes
- Deterministic replay, evidence packets, frozen research protocols, immutable analysis runs,
  finding packets, and holdout audit controls
- Dependence diagnostics, deterministic non-overlap sensitivity, episode/day/regime cluster
  bootstrap, effect distributions, materiality/friction policy, extreme-observation removal,
  randomized-timestamp falsification, and walk-forward analysis
- Read-only dashboard, collector supervision, restart handling, storage thresholds, PostgreSQL
  backup verification, retention controls, and operational status reporting

## Durable migrations

Forty transactional PostgreSQL migrations validate. The Phase 1 completion work includes:

- `0035_capital_flow_episode_v2.sql`: episode algorithm v2 and attribution fields
- `0036_research_analysis_runs.sql`: immutable analysis runs
- `0037_research_finding_packets.sql`: durable evidence packets
- `0038_remove_legacy_episode_window_uniqueness.sql`: removes the legacy constraint that blocked v2
  materialization
- `0039_episode_event_reverse_lookup.sql`: makes episode/BTC-relative research queries practical
- `0040_research_family_expansion.sql`: registers wallet behavior, market reaction, and
  conditional-combination families

## Quality gates

All gates passed after the final changes:

- Test files: 52/52
- Tests: 215/215
- Workspace package boundaries: 21/21
- Synthetic fixture sets: 4/4
- Transactional migrations: 40/40
- Read-only authority guard: passed; execution authority is `NONE`
- Coverage: 91.63% statements, 80.40% branches, 95.93% functions, 94.67% lines

## Live deployment snapshot

At the final measurement:

- Capital events: 2,155,595
- Algorithm-v2 capital-flow episodes: 10,425
- Episodes with matching versioned protocol context: 10,425 (100%)
- Persisted market-reaction records: 16,755
- Research runs: 24
- Finding packets: 18
- Holdout audit records: 0
- Collector: running
- Dashboard: running
- Storage: healthy with approximately 50.14 GiB free
- Dashboard authority endpoint confirms all write/trading capabilities are false

Forward-outcome maturity:

| Horizon | Outcomes |
| ------- | -------: |
| 1m      |  471,611 |
| 5m      |  468,705 |
| 15m     |  468,705 |
| 1h      |  398,384 |
| 6h      |   24,857 |
| 24h     |        0 |

The live feeds were approximately one second fresh during verification. Operational status remains
`DEGRADED` because the incident ledger recorded public-provider sequence gaps and reconnects in the
preceding hour. These incidents are retained as evidence and are not silently discarded.

## Throughput benchmarks

Earlier measured workstation validations remain the applicable engineering benchmarks:

- Solana collection/normalization: 100 blocks, 58,436 normalized events, 545.791 events/second, with
  no retries or failures in that bounded run
- Local PostgreSQL baseline: 11,399.94 transactions/second under `pgbench`

The PostgreSQL number is a local database baseline, not a CFIE production-throughput claim.
Production-scale RPC reliability, sustained replay throughput, and off-machine recovery still
require dedicated benchmarks.

## Frozen research protocols

### Full Phase 1 development run

Protocol v6: `protocol_6E03JYFFHW17XXCSG662YFGNGB`

- Dataset cutoff: `2026-10-05T09:27:02.7439873Z`
- Protocol code hash: `sha256:f515c8aec5720a9f36802caf3a4530393a59bba04f183e1581e041822a1ff3b6`
- Protocol content hash: `sha256:3490164d5ea5e050a8b922ed810b54736057d626b3cc3860dc1437a8251c1ac1`
- Holdout accessed: no

| Family                           | Observations | Corrected significant development cells | Economically material | Overlap-dependent | Result                      |
| -------------------------------- | -----------: | --------------------------------------: | --------------------: | ----------------: | --------------------------- |
| Transfer magnitude               |    1,787,540 |                                      13 |                     0 |                10 | Not supported               |
| Transfer magnitude, BTC-relative |      299,979 |                                      16 |                     0 |                 4 | Not supported               |
| Episode BTC-relative             |       15,683 |                                       0 |                     0 |                 1 | Insufficient data           |
| Direction                        |    1,792,943 |                                       8 |                     0 |                 6 | Not supported               |
| Wallet behavior                  |    1,792,943 |                                      12 |                     0 |                 5 | Not supported               |
| Market reaction                  |            0 |                                       0 |                     0 |                 0 | Insufficient data at cutoff |
| Conditional combination          |            0 |                                       0 |                     0 |                 0 | Insufficient data at cutoff |

The most illustrative raw transfer-magnitude cell selected 962 observations, but 99.896% overlapped
in time, with maximum overlap density 554 and only 12 deterministic non-overlapping observations.
Its full-sample effect was approximately +0.04354 percentage points, while its non-overlapping
effect was approximately +0.00144 percentage points. Conservative hypothetical friction was 0.26
percentage points, making the result economically weak.

The transfer-magnitude family produced 13 corrected nominal findings; 12 survived removal of the
five largest observations, but zero survived the randomized-timestamp alignment control. The
BTC-relative family had 16 nominal findings and seven randomized-timestamp survivors, but zero
economically material findings. No result was promoted.

### Reaction-pipeline completion run

Protocol v8: `protocol_5DN36JYWF3QKT2Z9JCMREFED76`

- Dataset cutoff: `2026-10-05T09:45:09.4208178Z`
- Protocol code hash: `sha256:8365f163ab7500706eaec340d7bec3764fd15c13c79b9ae0aa36bd3563069e0b`
- Protocol content hash: `sha256:489ca279a3efafa25793e83601301a27bc46bd38ac10f2daf319665d1cb89787`
- Research-ready reaction observations: 1,500
- Conditional-combination observations: 1,500
- Analyzable cohort cells: 3 per family
- Significant/material findings: 0/0
- Holdout accessed: no

The reaction scheduler now requires a matching forward outcome before materializing a research
reaction window. This prevents permanent accumulation of reaction records that can never be joined
to an outcome. The first research-ready batch contains 500 observations at each of 1m, 5m, and 15m.
It remains insufficient for comparative inference because the initial batch does not yet provide
adequate opposing cohorts.

## Provider constraints discovered

Coinbase Exchange's current public WebSocket rejects unauthenticated `level2`, `level3`, and `full`
subscriptions. CFIE therefore retains unauthenticated Coinbase public trades and uses Binance.US as
the current public Level-2 source. No exchange API key was added. The CLI output layer was also
hardened so PostgreSQL connection credentials are redacted from subsequent reports.

## Falsified or unsupported claims

- Large transfers alone have not demonstrated an economically useful effect.
- Nominal p-values in heavily overlapping event windows are not accepted as independent evidence.
- Direction and wallet-history cohorts have nominal development effects but none clear the
  materiality policy.
- Market-reaction and conditional families have data but not yet adequate comparative cohorts.
- No evidence currently justifies opening the holdout, simulating a deployable strategy, or placing
  a trade.

## Remaining blockers and next milestone

Phase 1 engineering is substantially complete, but the scientific experiment is not mature. The next
autonomous milestone is:

1. Continue uninterrupted read-only collection until 24-hour outcomes mature.
2. Continue outcome-aware reaction materialization to diversify cohorts and populate 1h/6h/24h
   pairs.
3. Reduce and characterize Coinbase/Binance sequence-gap causes without suppressing incident
   evidence.
4. Add an off-machine encrypted backup destination and execute a full restore drill.
5. Freeze a new protocol only after data maturity; rerun all families without opening the holdout.
6. Promote nothing unless effects survive non-overlap, clustered uncertainty, walk-forward,
   randomized controls, BTC/regime controls, materiality, and friction.

The correct current scientific conclusion is: CFIE can perform the experiment, but economic
usefulness has not yet been demonstrated.

## Continuation reliability improvements

The subsequent autonomous continuation corrected Coinbase public REST gap recovery. The collector
now uses Coinbase's `after` pagination cursor to request the exact missing historical trade-ID
interval rather than incorrectly querying the latest page. A live bounded validation recovered trade
IDs `356736500` through `356736504` exactly and in ascending order.

In the first measured period after deployment:

- Coinbase sequence gaps detected: 9
- Coinbase reconnects caused by incomplete REST backfill: 0
- Coinbase REST-backfilled raw messages: 1,310
- Coinbase live WebSocket raw messages: 1,662

Reaction research now also deduplicates observations by horizon and event timestamp. This prevents
hundreds of transfers from the same block timestamp, all sharing an identical market window, from
being treated as independent reaction evidence. The live scheduler favors recent eligible events so
the deduplicated reaction dataset gains new timestamps as collection continues.

Binance oversized aggregate-trade gaps now follow the same bounded, evidence-preserving policy as
Coinbase: record the exact incident and missing-count metadata, skip intervals larger than the
configured public REST recovery budget, and re-anchor on the current trade. This removes futile
reconnect loops without pretending that the missing interval was observed; affected research windows
remain excluded by the incident ledger.

## Entity and reaction intelligence continuation

Migration `0041_normalized_entity_addresses.sql` adds an immutable, indexed entity-to-address
mapping and backfills all existing entities. Point-in-time attribution queries now use this mapping
instead of repeatedly expanding JSON address arrays. On approximately 2.97 million capital events,
the complete CFIE dashboard report improved from about 25.49 seconds to about 13.03 seconds.

The current verified registry contains 17 protocol/bridge addresses from seven evidence sources with
zero conflicting claims. Verified wallet-endpoint coverage remains 0%; the known records are program
addresses rather than custodial wallet addresses. CFIE continues to report these endpoints as
unknown instead of converting program interaction into an invented wallet identity.

Reaction research is now explicitly causal: a 1-minute reaction feature may only be evaluated
against later 5m/15m/1h/6h/24h outcomes. Protocol v9 `protocol_6QAB2VN6R8HB4PDQF9NVJD4CE3` produced
25 unique-time observations across balanced flow, liquidity addition, liquidity withdrawal, and
spread widening. It remains `INSUFFICIENT_DATA`, with the holdout sealed. At the deployment
snapshot, 5,785 raw one-minute reaction records represented only 27 unique event timestamps; the
dashboard now exposes both values and uses the unique-time count for research-maturity progress.

## Entity verification candidate queue

CFIE now has a read-only candidate-discovery command that ranks high-activity transfer endpoints for
human or sourced verification. The output deliberately separates observed behavior from identity:
directional and hub labels are prefixed `HEURISTIC_`, and an endpoint remains `UNKNOWN` until a
point-in-time verified-address record supplies evidence. The queue does not call an address an
exchange, wallet owner, or protocol based on activity alone.

The first live run used a minimum of 1,000 observed events and returned the top 100 candidates in
8.00 seconds. The candidate set contained 41 receiver-like, 36 sender-like, 16 balanced-hub, and
seven high-counterparty-hub behavior profiles. The highest-activity endpoint appeared in 72,529
events with 13,040 distinct counterparties. Verified identities remained 0/100, which is the honest
result given the evidence currently loaded. Multi-asset quantities are intentionally not combined
for directional classification; classification uses transfer-event counts so incompatible token
units cannot produce a false net-flow claim.

Artifact: `artifacts/entity-verification-candidates-2026-10-05.json`

The dashboard now exposes the top 25 candidates in a dedicated verification queue. Its API is
read-only, uses the same 1,000-event threshold, and caches the eight-second aggregate for five
minutes so the normal 30-second dashboard refresh does not repeatedly scan the full event corpus.
Each row shows the address, observed behavior, event count, counterparty count, and explicit
identity status. The live deployment returned 25 candidates and 0 verified identities; a second
request was served from cache. No candidate was promoted into the verified registry.

## Evidence review and owner-aware normalization

Migration `0042_entity_verification_reviews.sql` adds immutable review history with `PENDING`,
`VERIFIED`, `REJECTED`, and `DEFERRED` states. A verified review requires complete proposed identity
and provenance fields. The persistence layer adds a stronger operational constraint: the exact
attribution must already exist in the verified registry and an immutable source snapshot with the
same source URL and evidence hash must exist before the review can be recorded as verified. The CLI
accepts strictly validated review files; the dashboard displays the latest review state alongside
each candidate.

Initial evidence discovery found that several highest-activity candidates are SPL token accounts,
not necessarily controlling wallets. For example, public results associate the leading endpoint with
PumpSwap fee plumbing, but the authoritative Pump public documentation identifies underlying
fee-recipient accounts rather than containing the candidate token-account address itself. It was
therefore not promoted under CFIE's literal-address evidence rule.

This exposed and corrected a normalization defect. Parser v3 now consumes the `owner` supplied in
Solana pre/post token balances and attributes SPL transfers to the controlling account when that
owner is present. It falls back to the token-account address only when owner data is absent. Native
SOL transfer behavior is unchanged. Existing immutable events are not rewritten; owner-aware data
begins at the parser-v3 deployment boundary, which must be respected in subsequent research.

## Historical owner correction

Migrations `0043_solana_token_account_owners.sql` and `0044_capital_event_owner_corrections.sql` add
a non-destructive historical correction layer. Archived raw blocks are inspected for owner fields in
Solana pre/post token balances, but mappings are retained only for accounts used by parsed SPL
transfer instructions. Every observation keeps the exact raw-object hash and timestamp that supplied
it. Capital events are not modified.

An indexed projection links an immutable event endpoint to its evidenced owner for the same raw
block. Entity candidate ranking now uses that owner when available and falls back to the original
endpoint otherwise. This avoids look-ahead and makes partial backfill safe. At the latest snapshot,
1,724 of 5,280 archived blocks had been processed, producing 1,007,971 owner-evidence rows and
1,197,621 corrected event endpoints. The remaining bounded backfill continues as a hidden local
process while live collection remains active.

The first partially corrected candidate run completed with 25 candidates and no verified identity.
Its 34.70-second aggregate remains too expensive for uncached interactive use, so the dashboard
retains its five-minute cache. Further rollup optimization is required after the backfill completes.

## Entity activity rollup

Migration `0045_entity_activity_rollups.sql` adds immutable, versioned activity rollup runs. A
bounded refresh aggregates owner-corrected endpoints once and retains the top 100,000 addresses,
including directional event counts, distinct counterparties, and first/last observation times.
Candidate discovery selects the newest rollup whose dataset cutoff is valid for the requested as-of
time, preserving point-in-time behavior.

The first rollup covered 6,398,080 event endpoints and 100,000 addresses. It took 41.42 seconds to
build. Reading and ranking 100 candidates from that rollup took 10 milliseconds, compared with 34.70
seconds for the prior live aggregate: approximately a 3,470-fold query improvement. The live
dashboard endpoint returned 25 candidates in 116 milliseconds wall-clock on its first uncached
request. The remaining owner backfill will automatically publish a new rollup when it finishes.

## First owner-level verified protocol attribution

Owner-corrected ranking exposed PumpSwap fee recipients among the highest-activity economic
endpoints. CFIE added all eight addresses listed in Pump's official `pump-public-docs` PumpSwap
README. The source sync fetched and content-hashed the official document, confirmed that every
literal address was present, archived one new immutable source snapshot, found zero conflicting
claims, and inserted eight new protocol attributions.

Eight corresponding `VERIFIED` review records were then accepted. Each review matched the imported
address, entity type, label, source URL, evidence hash, validity boundary, and archived source
snapshot. Attribution is not retroactive: the records become eligible only at their retrieval and
valid-from timestamp (`2026-10-05T15:35:43.251Z`). Historical events before that boundary remain
unknown, preventing hindsight from leaking into research.

The dashboard now reports owner-correction quality separately from identity coverage. At the first
live snapshot, 56.1% of archived blocks were owner-extracted, 2.23 million event endpoints were
corrected, 226,558 token accounts mapped to 124,441 economic owners, and the prior rollup still had
only 0.000146% verified endpoint coverage. A post-backfill rollup will incorporate the newly
verified PumpSwap endpoints for observations occurring after the evidence boundary.

## PumpSwap protocol-flow research foundation

Migration `0046_protocol_flow_windows.sql` adds immutable, versioned five-minute protocol-flow
features anchored to the eight verified PumpSwap fee recipients. Materialization resolves SPL token
accounts to their evidenced owners, accepts only native SOL and wrapped SOL transfers, enforces the
point-in-time attribution boundary, retains capped event evidence, and computes a trailing 12-window
event-count baseline. Only fully closed windows are published, preventing a partial live window from
becoming an immutable but incomplete research record.

The cohort classifier separates immature baselines, normal activity, two- and three-standard-
deviation surges, and two-standard-deviation collapses. A research observation adapter joins each
window anchor to matured forward outcomes and the market regime without opening the holdout. The
continuous read-only collector now performs this materialization each cycle, and the dashboard
exposes current window, event, counterparty, outcome, and burst-score counts.

The first live materialization completed in 7.85 seconds and produced zero eligible windows. This is
an expected `INSUFFICIENT_DATA` result: the official attribution became valid at
`2026-10-05T15:35:43.251Z`, and no qualifying SOL/WSOL fee-recipient transfer had yet been observed
after that boundary. CFIE did not back-label earlier events or weaken the evidence policy to create
a result. On the first upgraded continuous-collector cycle, CFIE then published the first closed
live window: 292 qualifying events from 249 distinct counterparties in the five-minute window
beginning at `2026-10-05T15:50:00Z`. Its baseline and forward outcomes were not yet mature, so no
statistical claim was made. Collection continues until enough independent windows and outcomes
accumulate.

The next cycle increased the corpus to two windows and 537 events. This exposed a more important
research boundary: a five-minute aggregate cannot use its first transfer as the outcome clock,
because the remaining transfers in that window would then be future information. Migration
`0047_protocol_flow_forward_outcomes.sql` therefore adds dedicated immutable outcomes observed at
the window close. General capital-event outcomes are no longer reused for this research family.

Live reference snapshots around the first windows were 65.7 to 96.1 seconds old, outside the frozen
30-second freshness policy. Rather than weakening that policy, CFIE now reconstructs only the
missing point-in-time estimates from archived Coinbase and Binance.US observations, using only data
whose timestamps were available at the requested historical instant. Withheld reconstructions are
not frozen, allowing a later retry if delayed raw data arrives. The first live run of this corrected
path produced two valid forward outcomes for one window. The corpus had reached three windows and
2,489 fee-flow events, but zero windows had a mature statistical baseline, so the conclusion
remained `INSUFFICIENT_DATA`.

## Frozen PumpSwap research protocol

CFIE froze `CFIE PumpSwap Protocol-Flow Research` version 1 before the baseline matured. Its
immutable protocol ID is `protocol_1AQAXYB54FTHFD8KSTXZZKB1XZ`, its 30-day dataset cutoff is
`2026-11-04T15:35:43.251Z`, and its seed is `20261005`. The registered hypothesis compares normal
windows with event-count Z-score cohorts at `z>=2`, `z>=3`, and `z<=-2` after 12 prior windows. Each
test requires at least 100 observations, Benjamini-Hochberg correction at a 5% false-discovery rate,
and the complete randomized-time, unconditional-SOL, BTC, regime, outlier, unseen-holdout, and cost
control set. The final 20% holdout remains sealed unless a separate promotion-evidence hash is
provided and audited.

The first development-only dry run exercised the complete persistence, analysis, and finding-packet
path with `holdoutAccessed=false`. It contained 11 horizon-level observations, all in the explicitly
immature-baseline cohort, and returned `INSUFFICIENT_DATA`. No effect, significance, or trading
claim was produced. Artifact: `artifacts/pumpswap-protocol-flow-development.json`.

## BTC-relative protocol-flow control

Migration `0049_protocol_flow_benchmark_outcomes.sql` adds immutable, window-aligned BTC benchmark
outcomes. Each matured SOL outcome is paired with Coinbase BTC/USD trades subject to the same
30-second entry-age and 60-second exit-delay limits. CFIE stores the SOL return, BTC return, and
SOL-minus-BTC excess return with exact entry/exit event evidence. A protocol-flow observation is not
admitted to analysis until this benchmark record exists.

The first live benchmark pass created 12/12 eligible BTC-relative outcomes. The subsequent
development-only run analyzed 12 excess-return observations, kept the holdout closed, and again
returned `INSUFFICIENT_DATA` because all windows remained baseline-immature. This satisfies the
registered BTC market-control boundary without claiming that the early positive mean excess returns
are signal.

The categorical research engine now also performs 99 deterministic circular timestamp-alignment
trials for every eligible cohort/horizon cell. This preserves the observed return sequence while
shifting cohort timing, directly testing whether the apparent effect depends on the real event
alignment. A cell cannot be marked significant unless both its false-discovery-adjusted permutation
result and its timestamp-alignment result pass the registered threshold. The current immature cells
have no comparison cohort, so the timestamp test correctly returns null rather than manufacturing a
p-value.

The live dashboard now exposes protocol readiness next to flow collection: frozen registration,
minimum sample size, current development observation count, timestamp-randomization trial count,
dataset cutoff, and holdout state. The deployed audit reports zero holdout accesses and displays
`SEALED`. This makes the absence of a result distinguishable from a missing or bypassed research
control.

## Storage growth control

A live PostgreSQL size audit measured 21.34 GB. The largest relations were raw objects (7.75 GB),
capital events (4.11 GB), token-account owner evidence (3.38 GB), general capital-event forward
outcomes (1.83 GB), and owner corrections (1.68 GB). The system had already accumulated 3.43 million
general forward outcomes and 855,879 general BTC benchmark outcomes.

Those general backfills were adding up to 10,000 and 2,000 records per collector cycle even though
the current milestone is PumpSwap research. The supervised collector now explicitly caps both
general backfills at zero while leaving PumpSwap window, SOL outcome, and BTC-relative outcome
labeling enabled. No existing data was deleted. The supervisor also reports a storage-drain forecast
using ten-minute sampling windows; shorter intervals remain null to avoid misleading annualization
of temporary database writes.

## Incremental owner extraction

Owner extraction is now a reusable bounded worker rather than a one-off backfill command. Each live
collection cycle processes at most 25 pending raw blocks with parallelism capped at two, persists
point-in-time owner evidence and endpoint corrections idempotently, and reports its remaining queue
in the cycle manifest. Entity activity rollups refresh every 60 completed cycles. Unknown identities
remain unknown; an extracted token-account owner is not treated as a real-world identity claim.

## Backup and operational visibility

The latest 3.86 GB PostgreSQL archive passed manifest byte-length and SHA-256 checks, PostgreSQL
archive listing, and a full data-only decompression stream. The verifier now writes a stable status
artifact consumed by the dashboard. The GUI exposes collector/dashboard supervision, available
storage, drain forecast, and backup verification age through a read-only operations endpoint.

## Immutable growing-dataset runs

Research run identity now includes both implementation hash and dataset hash. Migration 0050 stores
the dataset hash on every analysis run and expands the immutable uniqueness constraint accordingly,
allowing repeat development analyses as observations accumulate without overwriting prior evidence.
The sealed holdout remains unopened.

## Demonstration and external validation

`pnpm validation:package` creates a secret-free source archive with a per-file SHA-256 manifest. The
archive excludes live databases, dumps, logs, environment files, protected credentials, attachments,
build outputs, and dependency directories. A demonstration guide documents live and deterministic
offline operation and makes the no-execution authority boundary explicit.

## Process separation and continuous capture

Live capture and heavy derivation now run as separately leased and supervised processes. The
collector retains chain, market, normalization, reference-price, and 30-second lease-heartbeat work.
The derivation service independently materializes episodes, protocol contexts, market reactions,
regimes, PumpSwap windows and outcomes, owner evidence, and periodic entity rollups. Its first
verified cycle completed 100 episode records, 15 reaction candidates, one new PumpSwap window, one
SOL outcome, one BTC control, and 12,508 owner observations.

Capture segments were increased from one minute to one hour. The collector now heartbeats its lease
inside a running segment, so supervision remains current without deliberately reconnecting every
market feed each minute. This removes a major source of artificial reconnect and sequence-gap
incidents. Raw-data retention is configured at the approved seven days.

## Continuous development analysis

The supervisor launches the frozen PumpSwap protocol in development-only mode once per hour. Run
identity includes code and dataset hashes, and an unchanged rerun is idempotent: it neither inserts
a duplicate analysis nor a duplicate finding packet. The first scheduled separated-service run
contained 17 observations, returned `INSUFFICIENT_DATA`, and recorded `holdoutAccessed=false`.

Every successful scheduled PostgreSQL backup now invokes full backup verification automatically. The
supervisor and backup scheduled tasks were re-registered against PowerShell 7 to avoid the host's
legacy Windows PowerShell type-data loading fault.
