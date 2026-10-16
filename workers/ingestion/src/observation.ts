import { z } from "zod";
import type { MarketEvent } from "@autonomous-trading-lab/capital-flow";
import {
  BinanceDepthBook,
  binanceMessageMetadata,
  normalizeBinanceAggregateTrade,
  type BinancePublicRestDepthSource,
  type BinancePublicWebSocketFactory,
} from "@autonomous-trading-lab/binance-market-provider";
import {
  BoundedMarketStream,
  CoinbaseMarketSession,
  CoinbaseTradeSequenceError,
  fetchCoinbaseTradeGap,
  type CoinbaseTradeBackfillSource,
  type PublicMarketConnectionFactory,
  type ReconnectPolicy,
} from "@autonomous-trading-lab/coinbase-market-provider";
import { deterministicDomainId } from "@autonomous-trading-lab/domain";
import {
  FinalizedBlockCollector,
  type CollectionBatch,
  type FinalizedBlockSource,
} from "@autonomous-trading-lab/solana-chain-provider";
import { normalizeSolanaTransfers } from "@autonomous-trading-lab/solana-normalization";
import type { ResearchDatabase } from "./database.js";

const StoredRawBlockSchema = z
  .object({
    providerRef: z.string().min(1),
    chain: z.literal("solana"),
    sequence: z.string().regex(/^\d+$/),
    sourceTimestamp: z.iso.datetime({ offset: true }),
    payload: z.unknown(),
  })
  .strict();

export const SolanaObservationLimitsSchema = z
  .object({
    initialSlot: z.number().int().nonnegative(),
    maximumBatchSlots: z.number().int().min(1).max(500),
    maximumPolls: z.number().int().min(1).max(10_000),
    pollIntervalMs: z.number().int().min(250).max(60_000),
    maximumConsecutiveFailures: z.number().int().min(0).max(20),
    failureBackoffMs: z.number().int().min(250).max(60_000),
    maximumParallelBlocks: z.number().int().min(1).max(32).default(1),
    maximumPendingNormalizationJobs: z.number().int().min(1).max(100_000).default(1000),
    maximumLiveTailLagSlots: z.number().int().min(1).max(500_000).default(1000),
  })
  .strict();
export type SolanaObservationLimits = z.input<typeof SolanaObservationLimitsSchema>;

export interface SolanaObservationResult {
  readonly polls: number;
  readonly batches: number;
  readonly blocks: number;
  readonly gaps: number;
  readonly capitalEvents: number;
  readonly failures: number;
  readonly backpressurePauses: number;
  readonly lastFailure?: string;
  readonly stoppedByAbort: boolean;
}

export const SolanaNormalizationLimitsSchema = z
  .object({
    maximumJobs: z.number().int().min(1).max(100_000),
    claimBatchSize: z.number().int().min(1).max(100),
    leaseMs: z.number().int().min(1000).max(3_600_000),
    maximumAttempts: z.number().int().min(1).max(20),
    retryBackoffMs: z.number().int().min(0).max(3_600_000),
    maximumParallelJobs: z.number().int().min(1).max(32).default(1),
  })
  .strict();
export type SolanaNormalizationLimits = z.input<typeof SolanaNormalizationLimitsSchema>;

export interface SolanaNormalizationResult {
  readonly claimed: number;
  readonly completed: number;
  readonly retried: number;
  readonly failed: number;
  readonly capitalEvents: number;
}

export interface SolanaNormalizationWorkerResult extends SolanaNormalizationResult {
  readonly cycles: number;
}

export const CoinbaseObservationLimitsSchema = z
  .object({
    maximumMessages: z.number().int().min(1).max(1_000_000),
    maximumDurationMs: z.number().int().min(1000).max(3_600_000),
    reconnect: z
      .object({
        maximumAttempts: z.number().int().min(0).max(20),
        baseDelayMs: z.number().int().min(100).max(30_000),
        maximumDelayMs: z.number().int().min(100).max(60_000),
      })
      .strict(),
    maximumBackfillTrades: z.number().int().min(1).max(1000).default(100),
    bookSnapshotIntervalMs: z.number().int().min(100).max(60_000).default(1000),
  })
  .strict()
  .refine((value) => value.reconnect.maximumDelayMs >= value.reconnect.baseDelayMs, {
    message: "maximum reconnect delay must not be below the base delay",
  });
export type CoinbaseObservationLimits = z.input<typeof CoinbaseObservationLimitsSchema>;

export interface CoinbaseObservationResult {
  readonly connections: number;
  readonly messages: number;
  readonly reconnects: number;
  readonly rawMessagesInserted: number;
  readonly marketEventsInserted: number;
  readonly bookSnapshotsInserted: number;
  readonly marketDataIncidentsInserted: number;
  readonly backfilledMarketEvents: number;
  readonly stoppedByLimit: boolean;
}

export interface BinanceObservationResult {
  readonly connections: number;
  readonly messages: number;
  readonly reconnects: number;
  readonly rawMessagesInserted: number;
  readonly marketEventsInserted: number;
  readonly bookSnapshotsInserted: number;
  readonly marketDataIncidentsInserted: number;
  readonly backfilledMarketEvents: number;
  readonly stoppedByLimit: boolean;
}

export async function runBoundedBinanceObservation(
  factory: BinancePublicWebSocketFactory,
  rest: BinancePublicRestDepthSource,
  database: ResearchDatabase,
  symbol: string,
  venue: string,
  candidateLimits: CoinbaseObservationLimits,
  externalSignal: AbortSignal,
  delay?: (milliseconds: number) => Promise<void>,
): Promise<BinanceObservationResult> {
  const limits = CoinbaseObservationLimitsSchema.parse(candidateLimits);
  const tradeSource = `${venue}-aggTrade-websocket`;
  const budget = new AbortController();
  const duration = AbortSignal.timeout(limits.maximumDurationMs);
  const signal = AbortSignal.any([externalSignal, budget.signal, duration]);
  const stream = new BoundedMarketStream(factory, limits.reconnect, delay);
  let book: BinanceDepthBook | undefined;
  let handledMessages = 0;
  let rawMessagesInserted = 0;
  let marketEventsInserted = 0;
  let bookSnapshotsInserted = 0;
  let marketDataIncidentsInserted = 0;
  let backfilledMarketEvents = 0;
  let lastBookSnapshotAt = 0;
  let lastTradeId = await database.loadMarketTradeCheckpoint(tradeSource, venue, symbol);
  const persistTrade = async (message: unknown, source: string): Promise<void> => {
    const metadata = binanceMessageMetadata(message);
    const ingestedAt = new Date().toISOString();
    const raw = await database.persistRawMarketMessage({
      source,
      venue,
      productId: symbol,
      messageType: metadata.type,
      sequence: String(metadata.sequence),
      observedAt: metadata.eventTime,
      ingestedAt,
      payload: message,
    });
    if (raw.inserted) rawMessagesInserted += 1;
    const event = normalizeBinanceAggregateTrade(message, ingestedAt, venue);
    if (await database.persistMarketEvent(event)) marketEventsInserted += 1;
    await database.saveMarketTradeCheckpoint(
      tradeSource,
      venue,
      symbol,
      metadata.sequence,
      ingestedAt,
    );
    lastTradeId = metadata.sequence;
  };
  const result = await stream.run(
    async (message) => {
      const metadata = binanceMessageMetadata(message);
      if (metadata.symbol !== symbol) throw new Error("Binance stream symbol changed");
      const ingestedAt = new Date().toISOString();
      if (metadata.type === "aggTrade") {
        if (lastTradeId !== undefined && metadata.sequence <= lastTradeId) {
          handledMessages += 1;
          return;
        }
        if (lastTradeId !== undefined && metadata.sequence > lastTradeId + 1) {
          const missingTradeCount = metadata.sequence - lastTradeId - 1;
          const inserted = await database.persistMarketDataIncident({
            incidentType: "SEQUENCE_GAP",
            source: tradeSource,
            venue,
            productId: symbol,
            expectedSequence: String(lastTradeId + 1),
            receivedSequence: String(metadata.sequence),
            detectedAt: ingestedAt,
            details: {
              kind: "GAP",
              missingTradeCount,
              boundedRecovery: missingTradeCount <= limits.maximumBackfillTrades,
            },
          });
          if (inserted) marketDataIncidentsInserted += 1;
          if (missingTradeCount <= limits.maximumBackfillTrades) {
            const missing = await rest.aggregateTrades(
              symbol,
              lastTradeId + 1,
              metadata.sequence - 1,
              limits.maximumBackfillTrades,
            );
            for (const trade of missing) {
              await persistTrade(trade, `${venue}-rest-backfill`);
              backfilledMarketEvents += 1;
            }
          } else {
            // Preserve the incident, skip the unrecoverable bounded interval, and re-anchor on the
            // current public trade instead of entering a reconnect loop that cannot fill the gap.
            lastTradeId = metadata.sequence - 1;
          }
        }
        await persistTrade(message, tradeSource);
      } else {
        const raw = await database.persistRawMarketMessage({
          source: `${venue}-depth-websocket`,
          venue,
          productId: symbol,
          messageType: metadata.type,
          sequence: String(metadata.sequence),
          observedAt: metadata.eventTime,
          ingestedAt,
          payload: message,
        });
        if (raw.inserted) rawMessagesInserted += 1;
        let snapshotRawRef: `sha256:${string}` | undefined;
        if (!book) {
          const snapshot = await rest.snapshot(symbol);
          const storedSnapshot = await database.persistRawMarketMessage({
            source: `${venue}-depth-rest`,
            venue,
            productId: symbol,
            messageType: "snapshot",
            sequence: String(snapshot.lastUpdateId),
            ingestedAt,
            payload: snapshot,
          });
          if (storedSnapshot.inserted) rawMessagesInserted += 1;
          snapshotRawRef = storedSnapshot.rawRef;
          book = new BinanceDepthBook(snapshot);
        }
        if (book.apply(message)) {
          const snapshotTime = new Date(metadata.eventTime).getTime();
          if (snapshotTime - lastBookSnapshotAt >= limits.bookSnapshotIntervalMs) {
            const view = book.view(1000);
            const inserted = await database.persistOrderBookSnapshot({
              venue,
              instrumentId: deterministicDomainId("instrument", `${venue}:${symbol}`),
              sequence: view.sequence,
              observedAt: metadata.eventTime,
              bids: view.bids,
              asks: view.asks,
              inputRefs: snapshotRawRef ? [snapshotRawRef, raw.rawRef] : [raw.rawRef],
            });
            if (inserted) bookSnapshotsInserted += 1;
            lastBookSnapshotAt = snapshotTime;
          }
        }
      }
      handledMessages += 1;
      if (handledMessages >= limits.maximumMessages) budget.abort();
    },
    signal,
    async (event) => {
      book = undefined;
      const inserted = await database.persistMarketDataIncident({
        incidentType: "RECONNECT",
        source: `${venue}-websocket`,
        venue,
        productId: symbol,
        detectedAt: event.detectedAt,
        details: { attempt: event.attempt, reason: event.reason },
      });
      if (inserted) marketDataIncidentsInserted += 1;
    },
  );
  return {
    ...result,
    rawMessagesInserted,
    marketEventsInserted,
    bookSnapshotsInserted,
    marketDataIncidentsInserted,
    backfilledMarketEvents,
    stoppedByLimit: budget.signal.aborted || duration.aborted,
  };
}

const PublicMarketEnvelopeSchema = z
  .object({
    type: z.string().min(1),
    product_id: z.string().optional(),
    sequence: z.union([z.number().int().nonnegative(), z.string()]).optional(),
    trade_id: z.number().int().nonnegative().optional(),
    time: z.iso.datetime({ offset: true }).optional(),
  })
  .loose();

export async function runBoundedCoinbaseObservation(
  factory: PublicMarketConnectionFactory,
  database: ResearchDatabase,
  candidateLimits: CoinbaseObservationLimits,
  externalSignal: AbortSignal,
  delay?: (milliseconds: number) => Promise<void>,
  backfillSource?: CoinbaseTradeBackfillSource,
  checkpointProductId?: string,
): Promise<CoinbaseObservationResult> {
  const limits = CoinbaseObservationLimitsSchema.parse(candidateLimits);
  const budget = new AbortController();
  const duration = AbortSignal.timeout(limits.maximumDurationMs);
  const signal = AbortSignal.any([externalSignal, budget.signal, duration]);
  const persistedTradeId = checkpointProductId
    ? await database.loadMarketTradeCheckpoint(
        "coinbase-exchange-matches",
        "coinbase-exchange",
        checkpointProductId,
      )
    : undefined;
  const session = new CoinbaseMarketSession(persistedTradeId);
  const stream = new BoundedMarketStream(
    factory,
    limits.reconnect satisfies ReconnectPolicy,
    delay,
  );
  let handledMessages = 0;
  let rawMessagesInserted = 0;
  let marketEventsInserted = 0;
  let bookSnapshotsInserted = 0;
  let marketDataIncidentsInserted = 0;
  let backfilledMarketEvents = 0;
  let lastBookSnapshotAt = 0;
  const result = await stream.run(
    async (message) => {
      const envelope = PublicMarketEnvelopeSchema.parse(message);
      const ingestedAt = new Date().toISOString();
      const raw = await database.persistRawMarketMessage({
        source: "coinbase-exchange-websocket",
        venue: "coinbase-exchange",
        ...(envelope.product_id === undefined ? {} : { productId: envelope.product_id }),
        messageType: envelope.type,
        ...(envelope.sequence === undefined ? {} : { sequence: String(envelope.sequence) }),
        ...(envelope.time === undefined ? {} : { observedAt: envelope.time }),
        ingestedAt,
        payload: message,
      });
      if (raw.inserted) rawMessagesInserted += 1;
      if (envelope.type === "match" || envelope.type === "last_match") {
        let event: MarketEvent;
        try {
          event = session.acceptMatch(message, ingestedAt);
        } catch (error: unknown) {
          if (error instanceof CoinbaseTradeSequenceError) {
            const inserted = await database.persistMarketDataIncident({
              incidentType: "SEQUENCE_GAP",
              source: "coinbase-exchange-websocket",
              venue: "coinbase-exchange",
              productId: error.productId,
              expectedSequence: String(error.expectedTradeId),
              receivedSequence: String(error.receivedTradeId),
              detectedAt: ingestedAt,
              details: { kind: error.kind },
            });
            if (inserted) marketDataIncidentsInserted += 1;
            if (error.kind === "GAP" && backfillSource) {
              const missingTradeCount = error.receivedTradeId - error.expectedTradeId;
              if (missingTradeCount > limits.maximumBackfillTrades) {
                session.resynchronizeTradeId(error.receivedTradeId - 1);
                event = session.acceptMatch(message, ingestedAt);
                if (await database.persistMarketEvent(event)) marketEventsInserted += 1;
                if (envelope.trade_id !== undefined)
                  await database.saveMarketTradeCheckpoint(
                    "coinbase-exchange-matches",
                    "coinbase-exchange",
                    error.productId,
                    envelope.trade_id,
                    ingestedAt,
                  );
                handledMessages += 1;
                if (handledMessages >= limits.maximumMessages) budget.abort();
                return;
              }
              const backfill = await fetchCoinbaseTradeGap(
                backfillSource,
                error.productId,
                error.expectedTradeId,
                error.receivedTradeId - 1,
                limits.maximumBackfillTrades,
              );
              for (const missing of backfill) {
                const missingEnvelope = PublicMarketEnvelopeSchema.parse(missing);
                const missingIngestedAt = new Date().toISOString();
                const backfilledRaw = await database.persistRawMarketMessage({
                  source: "coinbase-exchange-rest-backfill",
                  venue: "coinbase-exchange",
                  ...(missingEnvelope.product_id === undefined
                    ? {}
                    : { productId: missingEnvelope.product_id }),
                  messageType: missingEnvelope.type,
                  ...(missingEnvelope.sequence === undefined
                    ? {}
                    : { sequence: String(missingEnvelope.sequence) }),
                  ...(missingEnvelope.time === undefined
                    ? {}
                    : { observedAt: missingEnvelope.time }),
                  ingestedAt: missingIngestedAt,
                  payload: missing,
                });
                if (backfilledRaw.inserted) rawMessagesInserted += 1;
                const missingEvent = session.acceptMatch(missing, missingIngestedAt);
                if (await database.persistMarketEvent(missingEvent)) backfilledMarketEvents += 1;
                if (missingEnvelope.trade_id !== undefined)
                  await database.saveMarketTradeCheckpoint(
                    "coinbase-exchange-matches",
                    "coinbase-exchange",
                    error.productId,
                    missingEnvelope.trade_id,
                    missingIngestedAt,
                  );
              }
              event = session.acceptMatch(message, ingestedAt);
              if (await database.persistMarketEvent(event)) marketEventsInserted += 1;
              if (envelope.trade_id !== undefined)
                await database.saveMarketTradeCheckpoint(
                  "coinbase-exchange-matches",
                  "coinbase-exchange",
                  error.productId,
                  envelope.trade_id,
                  ingestedAt,
                );
              handledMessages += 1;
              if (handledMessages >= limits.maximumMessages) budget.abort();
              return;
            }
            if (error.kind === "STALE_OR_DUPLICATE") {
              handledMessages += 1;
              if (handledMessages >= limits.maximumMessages) budget.abort();
              return;
            }
          }
          throw error;
        }
        if (await database.persistMarketEvent(event)) marketEventsInserted += 1;
        if (envelope.trade_id !== undefined && envelope.product_id !== undefined)
          await database.saveMarketTradeCheckpoint(
            "coinbase-exchange-matches",
            "coinbase-exchange",
            envelope.product_id,
            envelope.trade_id,
            ingestedAt,
          );
      } else if (envelope.type === "snapshot" || envelope.type === "l2update") {
        const productId = envelope.product_id;
        if (!productId) throw new Error("book message is missing a product ID");
        const book = session.acceptBookMessage(message);
        const snapshotTime = new Date(envelope.time ?? ingestedAt).getTime();
        if (
          envelope.type === "snapshot" ||
          snapshotTime - lastBookSnapshotAt >= limits.bookSnapshotIntervalMs
        ) {
          const inserted = await database.persistOrderBookSnapshot({
            venue: "coinbase-exchange",
            instrumentId: deterministicDomainId("instrument", `coinbase:${productId}`),
            sequence: book.sequence,
            observedAt: envelope.time ?? ingestedAt,
            bids: book.bids,
            asks: book.asks,
            inputRefs: [raw.rawRef],
          });
          if (inserted) bookSnapshotsInserted += 1;
          lastBookSnapshotAt = snapshotTime;
        }
      }
      handledMessages += 1;
      if (handledMessages >= limits.maximumMessages) budget.abort();
    },
    signal,
    async (event) => {
      const inserted = await database.persistMarketDataIncident({
        incidentType: "RECONNECT",
        source: "coinbase-exchange-websocket",
        venue: "coinbase-exchange",
        detectedAt: event.detectedAt,
        details: { attempt: event.attempt, reason: event.reason },
      });
      if (inserted) marketDataIncidentsInserted += 1;
      session.reconnect();
    },
  );
  return {
    ...result,
    rawMessagesInserted,
    marketEventsInserted,
    bookSnapshotsInserted,
    marketDataIncidentsInserted,
    backfilledMarketEvents,
    stoppedByLimit: budget.signal.aborted || duration.aborted,
  };
}

export async function runBoundedSolanaObservation(
  provider: FinalizedBlockSource,
  database: ResearchDatabase,
  candidateLimits: SolanaObservationLimits,
  signal: AbortSignal,
  delay: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<SolanaObservationResult> {
  const limits = SolanaObservationLimitsSchema.parse(candidateLimits);
  const storage = database.chainCollectionStorage();
  let capitalEvents = 0;
  const collector = new FinalizedBlockCollector(
    provider,
    storage,
    {
      async append(block): Promise<void> {
        const batch = normalizeSolanaTransfers(block, new Date().toISOString());
        const persisted = await database.persistCapitalBatch(block, batch);
        capitalEvents += persisted.eventsInserted;
      },
    },
    limits.initialSlot,
    limits.maximumBatchSlots,
    limits.maximumParallelBlocks,
  );
  const completed: CollectionBatch[] = [];
  let polls = 0;
  let failures = 0;
  let lastFailure: string | undefined;
  let consecutiveFailures = 0;
  const aborted = (): boolean => signal.aborted;
  while (polls < limits.maximumPolls && !aborted()) {
    try {
      const batch = await collector.pollOnce();
      polls += 1;
      consecutiveFailures = 0;
      if (batch) completed.push(batch);
    } catch (error: unknown) {
      polls += 1;
      failures += 1;
      lastFailure = error instanceof Error ? error.message : String(error);
      consecutiveFailures += 1;
      if (consecutiveFailures > limits.maximumConsecutiveFailures) throw error;
      await delay(Math.min(60_000, limits.failureBackoffMs * consecutiveFailures));
      continue;
    }
    if (aborted()) break;
    if (polls < limits.maximumPolls) await delay(limits.pollIntervalMs);
  }
  return {
    polls,
    batches: completed.length,
    blocks: completed.reduce((sum, batch) => sum + batch.blocks, 0),
    gaps: completed.reduce((sum, batch) => sum + batch.gaps.length, 0),
    capitalEvents,
    failures,
    backpressurePauses: 0,
    ...(lastFailure === undefined ? {} : { lastFailure }),
    stoppedByAbort: signal.aborted,
  };
}

export async function runBoundedSolanaCapture(
  provider: FinalizedBlockSource,
  database: ResearchDatabase,
  candidateLimits: SolanaObservationLimits,
  signal: AbortSignal,
  delay: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<SolanaObservationResult> {
  const limits = SolanaObservationLimitsSchema.parse(candidateLimits);
  const storage = database.chainCollectionStorage();
  const collector = new FinalizedBlockCollector(
    provider,
    storage,
    storage,
    limits.initialSlot,
    limits.maximumBatchSlots,
    limits.maximumParallelBlocks,
    limits.maximumLiveTailLagSlots,
  );
  const completed: CollectionBatch[] = [];
  let polls = 0;
  let failures = 0;
  let lastFailure: string | undefined;
  let backpressurePauses = 0;
  let consecutiveFailures = 0;
  const aborted = (): boolean => signal.aborted;
  while (polls < limits.maximumPolls && !aborted()) {
    const queue = await database.chainNormalizationQueueStatus();
    if (queue.pending + queue.processing >= limits.maximumPendingNormalizationJobs) {
      polls += 1;
      backpressurePauses += 1;
      if (polls < limits.maximumPolls) await delay(limits.pollIntervalMs);
      continue;
    }
    try {
      const batch = await collector.pollOnce();
      polls += 1;
      consecutiveFailures = 0;
      if (batch) completed.push(batch);
    } catch (error: unknown) {
      polls += 1;
      failures += 1;
      lastFailure = error instanceof Error ? error.message : String(error);
      consecutiveFailures += 1;
      if (consecutiveFailures > limits.maximumConsecutiveFailures) throw error;
      await delay(Math.min(60_000, limits.failureBackoffMs * consecutiveFailures));
      continue;
    }
    if (aborted()) break;
    if (polls < limits.maximumPolls) await delay(limits.pollIntervalMs);
  }
  return {
    polls,
    batches: completed.length,
    blocks: completed.reduce((sum, batch) => sum + batch.blocks, 0),
    gaps: completed.reduce((sum, batch) => sum + batch.gaps.length, 0),
    capitalEvents: 0,
    failures,
    backpressurePauses,
    ...(lastFailure === undefined ? {} : { lastFailure }),
    stoppedByAbort: signal.aborted,
  };
}

export async function drainSolanaNormalizationQueue(
  database: ResearchDatabase,
  candidateLimits: SolanaNormalizationLimits,
  signal: AbortSignal,
  clock: () => Date = () => new Date(),
): Promise<SolanaNormalizationResult> {
  const limits = SolanaNormalizationLimitsSchema.parse(candidateLimits);
  let claimed = 0;
  let completed = 0;
  let retried = 0;
  let failed = 0;
  let capitalEvents = 0;
  const aborted = (): boolean => signal.aborted;
  while (claimed < limits.maximumJobs && !aborted()) {
    const remaining = limits.maximumJobs - claimed;
    const jobs = await database.claimChainNormalizationJobs(
      clock().toISOString(),
      limits.leaseMs,
      Math.min(limits.claimBatchSize, remaining),
    );
    if (jobs.length === 0) break;
    claimed += jobs.length;
    let nextJob = 0;
    await Promise.all(
      Array.from({ length: Math.min(limits.maximumParallelJobs, jobs.length) }, async () => {
        while (nextJob < jobs.length) {
          const index = nextJob;
          nextJob += 1;
          // index is allocated from this same bounded local array.
          // eslint-disable-next-line security/detect-object-injection
          const job = jobs[index];
          if (!job) continue;
          try {
            const raw = await database.rawObject(job.rawObjectHash);
            const block = StoredRawBlockSchema.parse(raw);
            const batch = normalizeSolanaTransfers(block, job.createdAt, String(job.parserVersion));
            const persisted = await database.persistCapitalBatch(block, batch);
            capitalEvents += persisted.eventsInserted;
            await database.completeChainNormalizationJob(
              job.rawObjectHash,
              job.parserVersion,
              clock().toISOString(),
            );
            completed += 1;
          } catch (error: unknown) {
            const failedAt = clock();
            const result = await database.failChainNormalizationJob(
              job.rawObjectHash,
              job.parserVersion,
              job.attempts,
              failedAt.toISOString(),
              new Date(failedAt.getTime() + limits.retryBackoffMs * job.attempts).toISOString(),
              limits.maximumAttempts,
              error instanceof Error ? error.message : String(error),
            );
            if (result.status === "FAILED") failed += 1;
            else retried += 1;
          }
        }
      }),
    );
  }
  return { claimed, completed, retried, failed, capitalEvents };
}

export async function runBoundedSolanaNormalizationWorker(
  database: ResearchDatabase,
  candidateLimits: SolanaNormalizationLimits,
  maximumCycles: number,
  pollIntervalMs: number,
  signal: AbortSignal,
  delay: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<SolanaNormalizationWorkerResult> {
  if (!Number.isInteger(maximumCycles) || maximumCycles < 1 || maximumCycles > 100_000)
    throw new Error("maximumCycles must be between 1 and 100000");
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000)
    throw new Error("normalization poll interval must be between 100 and 60000ms");
  const totals = {
    cycles: 0,
    claimed: 0,
    completed: 0,
    retried: 0,
    failed: 0,
    capitalEvents: 0,
  };
  const aborted = (): boolean => signal.aborted;
  while (totals.cycles < maximumCycles && !aborted()) {
    const cycle = await drainSolanaNormalizationQueue(database, candidateLimits, signal);
    totals.cycles += 1;
    totals.claimed += cycle.claimed;
    totals.completed += cycle.completed;
    totals.retried += cycle.retried;
    totals.failed += cycle.failed;
    totals.capitalEvents += cycle.capitalEvents;
    if (!aborted() && totals.cycles < maximumCycles) await delay(pollIntervalMs);
  }
  return totals;
}
