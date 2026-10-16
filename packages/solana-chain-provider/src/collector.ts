import type { RawBlock } from "@autonomous-trading-lab/provider-sdk";
export interface FinalizedBlockSource {
  providerId(): string;
  latestFinalizedSlot(): Promise<number>;
  confirmedBlockSlots(startSlot: number, endSlot: number): Promise<readonly number[]>;
  getBlock(reference: string): Promise<RawBlock>;
}

export interface ChainCheckpoint {
  readonly providerId: string;
  readonly chain: "solana";
  readonly lastFinalizedSlot: number;
  readonly updatedAt: string;
}

export interface SlotGap {
  readonly providerId: string;
  readonly chain: "solana";
  readonly startSlot: number;
  readonly endSlot: number;
  readonly detectedAt: string;
  readonly reason: "SKIPPED_OR_UNAVAILABLE" | "LIVE_TAIL_FAST_FORWARD";
}

export interface ChainCheckpointStore {
  load(providerId: string, chain: "solana"): Promise<ChainCheckpoint | undefined>;
  save(checkpoint: ChainCheckpoint): Promise<void>;
  recordGap(gap: SlotGap): Promise<void>;
}

export interface RawBlockSink {
  append(block: RawBlock): Promise<void>;
  appendMany?(blocks: readonly RawBlock[]): Promise<void>;
}

export interface CollectionBatch {
  readonly fromSlot: number;
  readonly toSlot: number;
  readonly blocks: number;
  readonly gaps: readonly SlotGap[];
}

export class FinalizedBlockCollector {
  public constructor(
    private readonly provider: FinalizedBlockSource,
    private readonly checkpoints: ChainCheckpointStore,
    private readonly sink: RawBlockSink,
    private readonly initialSlot: number,
    private readonly maximumBatchSlots = 500,
    private readonly maximumParallelBlocks = 1,
    private readonly maximumLiveTailLagSlots?: number,
  ) {
    if (!Number.isSafeInteger(initialSlot) || initialSlot < 0)
      throw new Error("initialSlot must be a non-negative safe integer");
    if (
      !Number.isInteger(maximumBatchSlots) ||
      maximumBatchSlots < 1 ||
      maximumBatchSlots > 500_000
    )
      throw new Error("maximumBatchSlots must be between 1 and 500000");
    if (
      !Number.isInteger(maximumParallelBlocks) ||
      maximumParallelBlocks < 1 ||
      maximumParallelBlocks > 32
    )
      throw new Error("maximumParallelBlocks must be between 1 and 32");
    if (
      maximumLiveTailLagSlots !== undefined &&
      (!Number.isInteger(maximumLiveTailLagSlots) ||
        maximumLiveTailLagSlots < 1 ||
        maximumLiveTailLagSlots > 500_000)
    )
      throw new Error("maximumLiveTailLagSlots must be between 1 and 500000");
  }

  public async pollOnce(now = new Date().toISOString()): Promise<CollectionBatch | undefined> {
    const providerId = this.provider.providerId();
    const checkpoint = await this.checkpoints.load(providerId, "solana");
    let startSlot = checkpoint ? checkpoint.lastFinalizedSlot + 1 : this.initialSlot;
    const latest = await this.provider.latestFinalizedSlot();
    if (
      checkpoint !== undefined &&
      this.maximumLiveTailLagSlots !== undefined &&
      latest - checkpoint.lastFinalizedSlot > this.maximumLiveTailLagSlots
    ) {
      const skippedEndSlot = latest - 1;
      const gap: SlotGap = {
        providerId,
        chain: "solana",
        startSlot,
        endSlot: skippedEndSlot,
        detectedAt: now,
        reason: "LIVE_TAIL_FAST_FORWARD",
      };
      await this.checkpoints.recordGap(gap);
      await this.checkpoints.save({
        providerId,
        chain: "solana",
        lastFinalizedSlot: skippedEndSlot,
        updatedAt: now,
      });
      startSlot = latest;
    }
    if (latest < startSlot) return undefined;
    const endSlot = Math.min(latest, startSlot + this.maximumBatchSlots - 1);
    const confirmed = await this.provider.confirmedBlockSlots(startSlot, endSlot);
    const confirmedSet = new Set(confirmed);
    const gaps: SlotGap[] = [];
    let gapStart: number | undefined;
    for (let slot = startSlot; slot <= endSlot; slot += 1) {
      if (!confirmedSet.has(slot)) {
        gapStart ??= slot;
        continue;
      }
      if (gapStart !== undefined) {
        gaps.push({
          providerId,
          chain: "solana",
          startSlot: gapStart,
          endSlot: slot - 1,
          detectedAt: now,
          reason: "SKIPPED_OR_UNAVAILABLE",
        });
        gapStart = undefined;
      }
    }
    if (gapStart !== undefined)
      gaps.push({
        providerId,
        chain: "solana",
        startSlot: gapStart,
        endSlot,
        detectedAt: now,
        reason: "SKIPPED_OR_UNAVAILABLE",
      });
    const confirmedInRange = confirmed.filter((slot) => slot >= startSlot && slot <= endSlot);
    const captured: RawBlock[] = [];
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(this.maximumParallelBlocks, confirmedInRange.length) },
      async () => {
        while (nextIndex < confirmedInRange.length) {
          const index = nextIndex;
          nextIndex += 1;
          // index is allocated from this same bounded local array.
          // eslint-disable-next-line security/detect-object-injection
          const slot = confirmedInRange[index];
          if (slot === undefined) continue;
          const block = await this.provider.getBlock(String(slot));
          // index is allocated from this same bounded local array.
          // eslint-disable-next-line security/detect-object-injection
          captured[index] = block;
        }
      },
    );
    const settled = await Promise.allSettled(workers);
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) throw rejected.reason;
    const orderedBlocks = captured;
    if (this.sink.appendMany) await this.sink.appendMany(orderedBlocks);
    else {
      const writes = await Promise.allSettled(
        orderedBlocks.map((block) => this.sink.append(block)),
      );
      const failedWrite = writes.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failedWrite) throw failedWrite.reason;
    }
    for (const gap of gaps) await this.checkpoints.recordGap(gap);
    await this.checkpoints.save({
      providerId,
      chain: "solana",
      lastFinalizedSlot: endSlot,
      updatedAt: now,
    });
    return { fromSlot: startSlot, toSlot: endSlot, blocks: confirmedInRange.length, gaps };
  }
}

export class MemoryChainCheckpointStore implements ChainCheckpointStore {
  public checkpoint: ChainCheckpoint | undefined;
  public readonly gaps: SlotGap[] = [];

  public load(): Promise<ChainCheckpoint | undefined> {
    return Promise.resolve(this.checkpoint);
  }

  public save(checkpoint: ChainCheckpoint): Promise<void> {
    this.checkpoint = checkpoint;
    return Promise.resolve();
  }

  public recordGap(gap: SlotGap): Promise<void> {
    this.gaps.push(gap);
    return Promise.resolve();
  }
}
