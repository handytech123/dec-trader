# CFIE operational recovery report — 2026-10-16

## Scope

This recovery addressed the failed PostgreSQL backup task, unbounded filtered-stream reconciliation
growth, dependency advisories, repository verification, and the uncommitted CFIE source checkpoint.
The authority boundary remained `READ_ONLY_RESEARCH`; no wallet, signing, transaction submission,
exchange order, withdrawal, or capital-allocation capability was introduced.

## Repository verification

- Formatting, ESLint, and strict TypeScript build: pass.
- Tests: 324 passed across 79 files.
- Workspace boundaries: 27 packages passed.
- Fixtures: four synthetic fixture files passed validation.
- PostgreSQL migrations: 63 transactional migrations passed validation.
- Runtime authority guard: pass; execution authority is `NONE`.
- Coverage: 91.27% statements, 80.19% branches, 96.23% functions, and 94.60% lines.
- Dependency audit: no known vulnerabilities after upgrading `fflate` to 0.8.3 and overriding
  `source-map-js` to 1.2.2.

## Reconciliation recovery

At diagnosis, 384,397 filtered transactions awaited finalized reconciliation and the normalization
queue contained 5,859 pending jobs. Chain and market feeds were fresh, no reconciliation or
normalization jobs had failed, and there were no active market incidents.

The supervisor now applies independent hysteresis to filtered collection: collection pauses above
10,000 pending finalizations and resumes only at or below 5,000. After deployment, the filtered
collector stopped, the finalized reconciler continued, and the pending count fell to 384,004 while
remaining at zero failed reconciliations. Existing normalization hysteresis remains in force so the
reconciler pauses above 10,000 pending normalization jobs and resumes at or below 5,000.

The first task restart left pre-restart collector and dashboard descendants orphaned after their
former supervisor exited. Those stale process trees were identified by parent and command identity
and stopped. The current supervisor then reacquired the collection lease and restarted one canonical
collector and dashboard; filtered collection remains paused under backpressure.

This is controlled backlog recovery, not a Phase 3 exit. The system remains `DEGRADED` until the
pending finalization and normalization queues are reconciled and data completeness is re-measured.

## Backup recovery

The daily task failed for two independent reasons:

1. The backup script passed an undefined directory variable into verification.
2. A completed 170 GB archive lacked its manifest, causing the capacity estimate to deadlock against
   the remaining space on the backup volume.

The script now verifies against the resolved backup directory, retains two large recovery points by
default, and may prune only older complete backups when the newest complete archive has a matching
full verification report. It always keeps the newest verified archive while making capacity for the
next dump. Regression tests cover the corrected directory binding and verified-newest prerequisite.

The orphaned archive passed both `pg_restore --list` and a full data-stream decompression check
before adoption. Its SHA-256 manifest and verification record were regenerated. Older recovery
points are eligible for capacity-aware pruning only after that verification. A subsequent dump was
incorrectly started on `D:` and failed when that volume ran out of space; the failed partial was
preserved under `Z:\CFIE\backups\failed` for explicit later disposition and is not a recovery point.

## Storage correction — 2026-10-17

Backup and verification defaults now target `Z:\CFIE\backups`. The verified 170 GB archive, its
manifest, its verification record, the failed 223 GB partial, and the 18.68 GiB relocated backup
archive were moved from `D:` to `Z:`. The verified archive still has the recorded byte length of
170,415,849,259, its manifest points to the Z location, and `pg_restore --list` succeeds with 618
listing lines. The previously recorded SHA-256 remains
`8424a11a7fc3f0b9c0c283172cb736fef268e9bb4d43dcb191a68650400d652a`.

`Z:` is an SMB mapping to `\\192.168.1.108\Z`, so it is not a safe direct home for this Windows
PostgreSQL service or the live `.atl-data` runtime. PostgreSQL runs as
`NT AUTHORITY\NetworkService`, which cannot depend on the interactive user's mapped drive, and a
directory junction cannot target that network share. The live PostgreSQL data and `.atl-data`
therefore remain on local `D:` pending a local-volume or engineered database-host migration. The
supervisor now reports the workspace, database, and backup volumes separately and remains at
`READ_ONLY_RESEARCH` authority.

## Remaining gate

Phase 3 remains open until the backlog reaches a reconciled steady state and the seven-day evidence
window demonstrates complete, fresh data with no critical gaps. Candidate research effects remain
development-only; the holdout stays sealed and no signal is authorized for live trading.

## Capacity incident — 2026-10-19

The supervisor task had stopped while its collector, derivation, paper-strategy, and dashboard child
processes continued without supervision. The orphaned trees were stopped by command identity and the
supervisor was restarted. A stale collection lease expired normally before one replacement collector
reacquired it; no duplicate collector was started.

The database reached approximately 649 GiB, including 393 GiB of `raw_objects` and 207 GiB of
`capital_events`. The Solana collector was producing approximately 880,000 capital events per hour
and 1.4–1.7 GiB of compressed raw payloads per hour. A 300 GiB database-volume reserve now pauses
the collector, filtered collector, reconciler, and derivation service before the local volume
reaches an emergency threshold. The dashboard and paper-only strategy service remain available, and
the supervisor reports the pause explicitly. General forward-outcome and benchmark backfills are
again capped at zero as previously documented.

On October 19, 2026, the operator lowered this ingestion pause reserve to 100 GiB. The supervisor
continues to fail closed at or below that threshold and reports the configured reserve in its status
document.

The audited seven-day retention command exposed missing protection for newer raw-object foreign keys
and missing indexes required for bounded deletes. Retention now excludes protected provenance
objects, and migrations 0064–0065 add all lookup indexes needed by candidate selection and
foreign-key checks. The corrected command deleted 310,000 expired market frames in 31 audited
batches without deleting normalized research records.

Three prior failed dumps and one immediate failed retry occupied approximately 646 GiB on the Z
share without a completion manifest or verification record. Their contents were truncated to one
byte each, preserving failure filenames while reclaiming the quota. The verified October 12 recovery
point was not modified. The backup task no longer has an eight-hour execution limit, ignores a new
schedule while an instance is active, and a clean backup retry was started with high-volume
ingestion paused. It is not a recovery point until hashing, archive listing, and full data-stream
verification all pass.
