import { contentHash, deterministicDomainId } from "@autonomous-trading-lab/domain";
import { Decimal } from "decimal.js";

export type EpisodeEntityClass =
  | "CEX"
  | "DEX"
  | "BRIDGE"
  | "POOL"
  | "PROTOCOL"
  | "MARKET_MAKER"
  | "FUND"
  | "UNKNOWN";

export interface EpisodeInputEvent {
  readonly eventId: string;
  readonly eventTime: string;
  readonly assetId: string;
  readonly quantity: string;
  readonly sourceEntityId: string;
  readonly destinationEntityId: string;
  readonly sourceClass: EpisodeEntityClass;
  readonly destinationClass: EpisodeEntityClass;
  readonly protocolId?: string;
  readonly protocolVerifiedAt?: string;
  readonly attributionAsOf: string;
  readonly attributionEvidenceIds: readonly string[];
  readonly transactionSucceeded: boolean;
  readonly attributionAmbiguous: boolean;
}

export interface EpisodeConstructionConfig {
  readonly algorithmVersion: 2;
  readonly maximumTemporalSeparationSeconds: number;
  readonly requireSameAsset: true;
  readonly requireSameDirectedEntityPair: true;
  readonly requireDirectionCompatibility: true;
  readonly requireProtocolCompatibility: true;
  readonly excludeSelfTransfers: boolean;
  readonly excludeFailedTransactions: true;
  readonly excludeAmbiguousAttribution: boolean;
}

export interface CapitalFlowEpisode {
  readonly episodeId: string;
  readonly algorithmVersion: 2;
  readonly configHash: `sha256:${string}`;
  readonly contentHash: `sha256:${string}`;
  readonly start: string;
  readonly end: string;
  readonly anchorEventId: string;
  readonly memberEventIds: readonly string[];
  readonly eventCount: number;
  readonly assetId: string;
  readonly totalQuantity: string;
  readonly maximumQuantity: string;
  readonly direction: string;
  readonly sourceEntityId: string;
  readonly destinationEntityId: string;
  readonly sourceClass: EpisodeEntityClass;
  readonly destinationClass: EpisodeEntityClass;
  readonly protocolId?: string;
  readonly attributionAsOf: string;
  readonly attributionEvidenceIds: readonly string[];
  readonly quality: "VERIFIED_CONTEXT" | "ATTRIBUTED" | "UNKNOWN_CONTEXT";
}

export const defaultEpisodeConstructionConfig: EpisodeConstructionConfig = Object.freeze({
  algorithmVersion: 2,
  maximumTemporalSeparationSeconds: 30,
  requireSameAsset: true,
  requireSameDirectedEntityPair: true,
  requireDirectionCompatibility: true,
  requireProtocolCompatibility: true,
  excludeSelfTransfers: true,
  excludeFailedTransactions: true,
  excludeAmbiguousAttribution: true,
});

function validateConfig(config: EpisodeConstructionConfig): void {
  if (
    !Number.isInteger(config.maximumTemporalSeparationSeconds) ||
    config.maximumTemporalSeparationSeconds < 1 ||
    config.maximumTemporalSeparationSeconds > 3600
  )
    throw new Error("maximum temporal separation must be between 1 and 3600 seconds");
}

const compatibilityKey = (event: EpisodeInputEvent): string =>
  JSON.stringify([
    event.assetId,
    event.sourceEntityId,
    event.destinationEntityId,
    event.sourceClass,
    event.destinationClass,
    event.protocolId ?? null,
  ]);

export function constructCapitalFlowEpisodes(
  input: readonly EpisodeInputEvent[],
  config: EpisodeConstructionConfig = defaultEpisodeConstructionConfig,
): readonly CapitalFlowEpisode[] {
  validateConfig(config);
  const configHash = contentHash(config);
  const eligible = input
    .filter((event) => event.transactionSucceeded)
    .filter((event) => !config.excludeAmbiguousAttribution || !event.attributionAmbiguous)
    .filter(
      (event) => !config.excludeSelfTransfers || event.sourceEntityId !== event.destinationEntityId,
    )
    .map((event) => ({ event, time: new Date(event.eventTime).getTime() }))
    .sort(
      (left, right) =>
        left.time - right.time || left.event.eventId.localeCompare(right.event.eventId),
    );
  if (eligible.some(({ time }) => !Number.isFinite(time)))
    throw new Error("invalid event timestamp");

  const groups: EpisodeInputEvent[][] = [];
  const currentGroupByKey = new Map<string, number>();
  for (const { event, time } of eligible) {
    const key = compatibilityKey(event);
    const groupIndex = currentGroupByKey.get(key);
    // The index originates from this local array's map and is never externally supplied.
    // eslint-disable-next-line security/detect-object-injection
    const previous = groupIndex === undefined ? undefined : groups[groupIndex];
    const last = previous?.at(-1);
    const gap = last ? time - new Date(last.eventTime).getTime() : Number.POSITIVE_INFINITY;
    if (previous && last && gap <= config.maximumTemporalSeparationSeconds * 1000) {
      previous.push(event);
    } else {
      groups.push([event]);
      currentGroupByKey.set(key, groups.length - 1);
    }
  }

  return groups
    .sort((left, right) => {
      const leftAnchor = left.at(0);
      const rightAnchor = right.at(0);
      if (!leftAnchor || !rightAnchor) throw new Error("episode group unexpectedly empty");
      return (
        new Date(leftAnchor.eventTime).getTime() - new Date(rightAnchor.eventTime).getTime() ||
        leftAnchor.eventId.localeCompare(rightAnchor.eventId)
      );
    })
    .map((events) => {
      const anchor = events.at(0);
      const finalEvent = events.at(-1);
      if (!anchor || !finalEvent) throw new Error("episode group unexpectedly empty");
      const total = events.reduce((sum, event) => sum.plus(event.quantity), new Decimal(0));
      const maximum = events.reduce(
        (value, event) => Decimal.max(value, new Decimal(event.quantity)),
        new Decimal(0),
      );
      const evidenceIds = [
        ...new Set(events.flatMap((event) => event.attributionEvidenceIds)),
      ].sort();
      const attributionAsOf = events
        .map((event) => event.attributionAsOf)
        .sort()
        .at(-1);
      if (!attributionAsOf) throw new Error("episode attribution timestamp is missing");
      const identity = {
        algorithmVersion: config.algorithmVersion,
        configHash,
        assetId: anchor.assetId,
        sourceEntityId: anchor.sourceEntityId,
        destinationEntityId: anchor.destinationEntityId,
        protocolId: anchor.protocolId ?? null,
        memberEventIds: events.map((event) => event.eventId),
      };
      const episodeId = deterministicDomainId("episode", contentHash(identity));
      const episodeWithoutHash = {
        episodeId,
        algorithmVersion: config.algorithmVersion,
        configHash,
        start: anchor.eventTime,
        end: finalEvent.eventTime,
        anchorEventId: anchor.eventId,
        memberEventIds: identity.memberEventIds,
        eventCount: events.length,
        assetId: anchor.assetId,
        totalQuantity: total.toString(),
        maximumQuantity: maximum.toString(),
        direction: `${anchor.sourceClass}→${anchor.destinationClass}`,
        sourceEntityId: anchor.sourceEntityId,
        destinationEntityId: anchor.destinationEntityId,
        sourceClass: anchor.sourceClass,
        destinationClass: anchor.destinationClass,
        ...(anchor.protocolId === undefined ? {} : { protocolId: anchor.protocolId }),
        attributionAsOf,
        attributionEvidenceIds: evidenceIds,
        quality:
          anchor.protocolId && anchor.protocolVerifiedAt
            ? ("VERIFIED_CONTEXT" as const)
            : anchor.sourceClass === "UNKNOWN" && anchor.destinationClass === "UNKNOWN"
              ? ("UNKNOWN_CONTEXT" as const)
              : ("ATTRIBUTED" as const),
      };
      return { ...episodeWithoutHash, contentHash: contentHash(episodeWithoutHash) };
    });
}
