import type { PersistedMarketReaction, ResearchDatabase } from "./database.js";

export interface MarketReactionTarget {
  readonly venue: string;
  readonly instrumentId: string;
}

export interface MarketReactionMaturationResult {
  readonly asOf: string;
  readonly candidates: number;
  readonly completed: number;
  readonly failed: number;
  readonly windows: readonly {
    readonly venue: string;
    readonly instrumentId: string;
    readonly windowSeconds: number;
    readonly candidates: number;
    readonly completed: number;
    readonly failed: number;
  }[];
  readonly failureSamples: readonly { readonly eventId: string; readonly error: string }[];
}

type MarketReactionStore = Pick<
  ResearchDatabase,
  "pendingMarketReactionEventIds" | "computeAndPersistMarketReaction"
>;

export async function matureMarketReactions(
  database: MarketReactionStore,
  input: {
    readonly targets: readonly MarketReactionTarget[];
    readonly windowsSeconds: readonly number[];
    readonly asOf: string;
    readonly maximumEventsPerWindow: number;
    readonly maximumSnapshotAgeSeconds: number;
  },
): Promise<MarketReactionMaturationResult> {
  let candidates = 0;
  let completed = 0;
  let failed = 0;
  const windows: MarketReactionMaturationResult["windows"][number][] = [];
  const failureSamples: { eventId: string; error: string }[] = [];
  for (const target of input.targets) {
    for (const windowSeconds of input.windowsSeconds) {
      const eventIds = await database.pendingMarketReactionEventIds({
        ...target,
        windowSeconds,
        asOf: input.asOf,
        maximumEvents: input.maximumEventsPerWindow,
        maximumSnapshotAgeSeconds: input.maximumSnapshotAgeSeconds,
      });
      let windowCompleted = 0;
      let windowFailed = 0;
      for (const eventId of eventIds) {
        try {
          const result: PersistedMarketReaction = await database.computeAndPersistMarketReaction({
            capitalEventId: eventId,
            ...target,
            windowSeconds,
            maximumSnapshotAgeSeconds: input.maximumSnapshotAgeSeconds,
          });
          if (result.capitalEventId !== eventId)
            throw new Error("market-reaction result does not match the candidate event");
          windowCompleted += 1;
        } catch (error: unknown) {
          windowFailed += 1;
          if (failureSamples.length < 20)
            failureSamples.push({
              eventId,
              error: error instanceof Error ? error.message : String(error),
            });
        }
      }
      candidates += eventIds.length;
      completed += windowCompleted;
      failed += windowFailed;
      windows.push({
        ...target,
        windowSeconds,
        candidates: eventIds.length,
        completed: windowCompleted,
        failed: windowFailed,
      });
    }
  }
  return { asOf: input.asOf, candidates, completed, failed, windows, failureSamples };
}
