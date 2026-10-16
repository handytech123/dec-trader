# CFIE read-only operations and recovery

**Authority:** read-only research. Execution authority is none.

## Supervision

`scripts/register-cfie-operations.ps1` installs log-on supervision and daily database backup tasks.
The supervisor rebuilds before launch, restarts the collector and dashboard after bounded delay,
inherits the database credential only from a Windows DPAPI-protected file, and writes health to
`.atl-data/cfie-supervisor/status.json`. The database collection lease prevents two collectors from
owning the same stream. `SIGTERM`/process shutdown is handled by the Node services; reconnects and
sequence gaps become incidents rather than silently continuous L2 history.

The supervisor measures free space on the workspace volume each cycle. Defaults are warning at 20
GiB and critical at 5 GiB. At critical free space it stops the collector and does not restart it
until capacity recovers. The dashboard remains available to expose the condition. This favors an
explicit evidence gap over partial or silently discarded evidence. Thresholds are configurable via
the supervisor parameters and must keep warning above critical.

The full-block Solana fallback runs at one sampled finalized block per minute. This is a bounded
continuity/recovery feed, not chain-complete capture. Measured full-block capture at two blocks per
ten seconds produced roughly 760 MiB of compressed raw objects and 415,398 normalized events per
hour, which is not sustainable on the local volume. Continuous relevant-transaction capture should
use the filtered Helius stream, with finalized RPC reconciliation for gaps.

## Storage inventory

Monitor all of the following, not merely database size:

- raw market frames and order-book snapshots;
- raw Solana blocks/filtered transactions and content-addressed objects;
- normalized capital events, entity claims, episodes and outcomes;
- market-data incident and checkpoint tables;
- frozen protocols, analysis runs, holdout audits and finding/rejection packets;
- supervisor logs and PostgreSQL backup manifests.

Retention must never delete evidence referenced by an immutable research artifact. A warning
requires capacity planning; a critical condition pauses collection. Never make room by deleting an
unverified backup or the only copy of raw L2 evidence.

## Vendor-neutral off-machine backup

Maintain at least two off-machine copies: one encrypted object-store copy and one independently
restorable copy. Include PostgreSQL custom-format dumps, irreplaceable raw L2 frames, costly chain
objects, configuration, migration files, frozen protocols and manifests containing SHA-256 hashes.
Object storage may be S3-compatible, Azure Blob, GCS, or removable encrypted media; no provider is
required by the design. Credentials belong in the host secret store, never in the repository.

Each backup run must produce a manifest with creation time, source revision, database dump hash,
raw-object inventory hash, byte counts and retention class. Copy the manifest separately so a
missing or altered backup is detectable.

## Recovery drill

Run this drill on a disposable database and raw-object directory:

1. Record current checkpoints, counts, incident totals and representative content hashes.
2. Stop the scheduled supervisor and confirm the collector lease expires or is released.
3. Restore the PostgreSQL dump and raw objects into isolated paths.
4. Apply migrations; verify manifest hashes and immutable record counts.
5. Start one bounded collector against the restored checkpoint.
6. Confirm canonical deduplication prevents duplicate events and outcomes.
7. Confirm any unavoidable L2 interval is recorded as a reconnect/sequence-gap incident.
8. Recompute a recorded research run and compare its result/content hash.
9. Stop the drill instance, then restart the production supervisor once.

Success requires exact hashes for immutable inputs and deterministic artifacts. A mismatch, unproven
provenance, missing raw dependency or unrecorded market-data gap fails the drill and blocks research
promotion. Database and raw-object restores must also be tested independently so one does not
conceal damage in the other.
