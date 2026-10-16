# ADR 0009: Filtered Solana stream boundary

## Status

Accepted for implementation; live validation is gated by provider-plan access.

## Context

Full finalized Solana blocks preserve complete evidence but cannot currently be fetched, compressed,
and persisted at the chain-head rate on the local host. Helius RPC itself is reliable; measured
network-only retrieval reached 2.175 full parsed blocks per second, while durable end-to-end capture
remained below one block per second.

Helius Enhanced WebSockets provide the `transactionSubscribe` method with server-side
`accountInclude`, `accountExclude`, and `accountRequired` filters. Current Helius documentation
lists that method on Developer plans and above, not on Free. The current CFIE key successfully
accesses ordinary mainnet RPC but did not open the Enhanced WebSocket endpoint during the bounded
access test.

## Decision

CFIE will add a read-only filtered transaction adapter using `transactionSubscribe` after provider
access is available. The first subscription set will include:

- Solana System Program for native SOL activity;
- legacy SPL Token Program;
- Token-2022 Program;
- explicitly verified exchange, bridge, DEX, and liquidity-pool program or account addresses.

Failed transactions and vote transactions will be excluded. Commitment will initially be
`confirmed`, with every accepted transaction later reconciled against finalized RPC history before
it becomes research evidence.

Every accepted message must retain the original JSON payload, slot, signature, provider receive
time, content hash, subscription/filter identity, and parser version. Unknown attribution remains
unknown.

## Recovery requirements

Enhanced WebSockets do not replace durable recovery logic. CFIE must persist its highest contiguous
reconciled slot, detect reconnect boundaries, backfill the missing interval through finalized RPC,
and resume live ingestion without silently skipping data. Only finalized and reconciled records may
enter forward-outcome research.

## Cost boundary

The $49 Developer tier is the maximum justified tier for this validation. Business or Professional
service is not required for Enhanced WebSocket `transactionSubscribe`. Subscription purchase and
billing remain explicit user actions; CFIE contains no code that can purchase a plan or submit a
transaction.

## Consequences

- Full-block RPC remains the evidence-complete fallback and recovery path.
- The filtered stream reduces routine bandwidth and local parsing work.
- Server-side filters can omit activity if configured incorrectly, so fixture tests and finalized
  reconciliation are mandatory.
- Streamed bandwidth is metered separately by Helius and must be measured during a bounded pilot
  before continuous operation.
