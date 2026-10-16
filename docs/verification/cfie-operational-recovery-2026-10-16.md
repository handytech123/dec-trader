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
points are eligible for capacity-aware pruning only after that verification. The repaired task then
retained the verified 170 GB archive, pruned the older copies, restored 216.68 GiB of free
backup-volume capacity, and started a current PostgreSQL custom-format dump. The task remains
responsible for hashing and full archive/data-stream verification before publishing the new recovery
point.

## Remaining gate

Phase 3 remains open until the backlog reaches a reconciled steady state and the seven-day evidence
window demonstrates complete, fresh data with no critical gaps. Candidate research effects remain
development-only; the holdout stays sealed and no signal is authorized for live trading.
