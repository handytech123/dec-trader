# CFIE v0.2 Phase 1.1 verification report

- Date: 2026-09-30
- Status: Complete
- Scope: Read-only finalized Solana block collection foundation

## Delivered

- A Solana chain provider behind the vendor-neutral `ChainProvider` boundary.
- Finalized-slot polling using `getSlot`, `getBlocks`, and `getBlock` request shapes.
- Recorded official-shape block fixtures; normal tests make no network requests.
- Checkpoint advancement only after every available block in the batch is accepted by the sink.
- Explicit skipped-or-unavailable slot ranges rather than silent gaps.
- Recovery behavior that leaves the checkpoint unchanged after a transport failure.
- PostgreSQL migrations for durable checkpoints, gap records, and immutable raw block payloads.

## Design decision

The initial collector uses finalized HTTP polling. Solana documents `blockSubscribe` as unstable and
dependent on validator flags, while the HTTP methods provide bounded replay from a durable
checkpoint. A WebSocket optimization can be evaluated later without changing the canonical sink or
checkpoint contracts.

## Safety boundary

The adapter exposes only block reads. Transfer extraction remains Phase 1.2. It contains no wallet,
key, signing, simulation, transaction submission, trading credential, or exchange-order capability.

## Recommended next step

Phase 1.2 should transform recorded raw block transactions into canonical `CapitalEvent` transfers,
preserving raw-object provenance and parser version. Begin with native SOL transfers and one SPL
Token transfer form from fixtures before expanding instruction coverage.
