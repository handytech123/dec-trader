import { Decimal } from "decimal.js";
import { contentHash } from "@autonomous-trading-lab/domain";
import type { CapitalEvent } from "./schemas.js";
import {
  VerifiedEntityAddressSchema,
  type VerifiedEntityAddress,
} from "./verified-entity-registry.js";

export type EntityIntelligenceClass = VerifiedEntityAddress["entityType"] | "UNKNOWN" | "CONFLICT";

export interface EntityResolution {
  readonly address: string;
  readonly asOf: string;
  readonly status: "VERIFIED" | "UNKNOWN" | "CONFLICT";
  readonly entityClass: EntityIntelligenceClass;
  readonly label?: string;
  readonly evidenceHashes: readonly `sha256:${string}`[];
  readonly sources: readonly string[];
}

export type CapitalFlowDirection =
  | "EXCHANGE_INFLOW"
  | "EXCHANGE_OUTFLOW"
  | "BRIDGE_INFLOW"
  | "BRIDGE_OUTFLOW"
  | "PROTOCOL_INFLOW"
  | "PROTOCOL_OUTFLOW"
  | "POOL_INFLOW"
  | "POOL_OUTFLOW"
  | "KNOWN_TO_KNOWN"
  | "UNATTRIBUTED"
  | "AMBIGUOUS";

export interface WalletBehaviorFeature {
  readonly featureVersion: 1;
  readonly entityId: string;
  readonly eventId: string;
  readonly asOf: string;
  readonly historyCount: number;
  readonly quantityZScore: string | null;
  readonly dormancySeconds: number | null;
  readonly prior24HourEventCount: number;
  readonly newCounterparty: boolean | null;
  readonly evidenceEventIds: readonly string[];
  readonly contentHash: `sha256:${string}`;
}

export interface WalletBehaviorFeatureV2 {
  readonly featureVersion: 2;
  readonly entityId: string;
  readonly eventId: string;
  readonly asOf: string;
  readonly status: "READY" | "INSUFFICIENT_HISTORY";
  readonly minimumHistory: number;
  readonly historyCount: number;
  readonly quantityZScore: string | null;
  readonly quantityPercentile: string | null;
  readonly frequencyZScore: string | null;
  readonly dormancySeconds: number | null;
  readonly inboundCount: number;
  readonly outboundCount: number;
  readonly inboundQuantity: string;
  readonly outboundQuantity: string;
  readonly netFlowQuantity: string;
  readonly counterpartyConcentration: string | null;
  readonly newCounterparty: boolean | null;
  readonly evidenceEventIds: readonly string[];
  readonly contentHash: `sha256:${string}`;
}

export type WalletBehaviorEvent = Pick<
  CapitalEvent,
  "eventId" | "eventTime" | "quantity" | "fromEntityId" | "toEntityId"
>;

export interface EntityRegistryAudit {
  readonly recordCount: number;
  readonly addressCount: number;
  readonly sourceCount: number;
  readonly conflictingOverlapCount: number;
  readonly issues: readonly {
    readonly severity: "ERROR" | "WARNING";
    readonly address: string;
    readonly message: string;
  }[];
  readonly safeToImport: boolean;
}

export function auditVerifiedEntityRegistry(
  candidates: readonly VerifiedEntityAddress[],
): EntityRegistryAudit {
  const records = candidates.map((candidate) => VerifiedEntityAddressSchema.parse(candidate));
  const byAddress = new Map<string, VerifiedEntityAddress[]>();
  const sources = new Set<string>();
  for (const record of records) {
    const current = byAddress.get(record.address) ?? [];
    current.push(record);
    byAddress.set(record.address, current);
    sources.add(record.source);
  }
  const issues: EntityRegistryAudit["issues"][number][] = [];
  for (const [address, addressRecords] of byAddress) {
    const sorted = [...addressRecords].sort((left, right) =>
      left.validFrom.localeCompare(right.validFrom),
    );
    for (const [leftIndex, left] of sorted.entries()) {
      for (const right of sorted.slice(leftIndex + 1)) {
        const leftEnd = left.validTo ?? "9999-12-31T23:59:59.999Z";
        const rightEnd = right.validTo ?? "9999-12-31T23:59:59.999Z";
        const overlaps = left.validFrom <= rightEnd && right.validFrom <= leftEnd;
        if (overlaps && (left.entityType !== right.entityType || left.label !== right.label))
          issues.push({
            severity: "ERROR",
            address,
            message: `overlapping claims disagree: ${left.label} (${left.entityType}) vs ${right.label} (${right.entityType})`,
          });
      }
    }
    if (new Set(addressRecords.map((record) => record.source)).size === 1)
      issues.push({
        severity: "WARNING",
        address,
        message: "address attribution has only one evidence source",
      });
  }
  const conflictingOverlapCount = issues.filter((issue) => issue.severity === "ERROR").length;
  return {
    recordCount: records.length,
    addressCount: byAddress.size,
    sourceCount: sources.size,
    conflictingOverlapCount,
    issues,
    safeToImport: conflictingOverlapCount === 0,
  };
}

export function resolveVerifiedAddress(
  address: string,
  asOf: string,
  candidates: readonly VerifiedEntityAddress[],
): EntityResolution {
  const asOfMs = new Date(asOf).getTime();
  if (!Number.isFinite(asOfMs)) throw new Error("asOf must be a valid timestamp");
  const applicable = candidates
    .map((candidate) => VerifiedEntityAddressSchema.parse(candidate))
    .filter(
      (candidate) =>
        candidate.address === address &&
        candidate.retrievedAt <= asOf &&
        candidate.validFrom <= asOf &&
        (candidate.validTo === undefined || candidate.validTo >= asOf),
    );
  if (applicable.length === 0)
    return {
      address,
      asOf,
      status: "UNKNOWN",
      entityClass: "UNKNOWN",
      evidenceHashes: [],
      sources: [],
    };
  const identities = new Set(applicable.map((item) => `${item.entityType}:${item.label}`));
  const evidenceHashes = [
    ...new Set<`sha256:${string}`>(
      applicable.map((item) => item.evidenceHash as `sha256:${string}`),
    ),
  ].sort();
  const sources = [...new Set(applicable.map((item) => item.source))].sort();
  if (identities.size !== 1)
    return {
      address,
      asOf,
      status: "CONFLICT",
      entityClass: "CONFLICT",
      evidenceHashes,
      sources,
    };
  const resolved = applicable[0];
  if (!resolved) throw new Error("applicable entity resolution unexpectedly absent");
  return {
    address,
    asOf,
    status: "VERIFIED",
    entityClass: resolved.entityType,
    label: resolved.label,
    evidenceHashes,
    sources,
  };
}

export function classifyCapitalFlowDirection(
  from: EntityResolution,
  to: EntityResolution,
): CapitalFlowDirection {
  if (from.status === "CONFLICT" || to.status === "CONFLICT") return "AMBIGUOUS";
  if (to.entityClass === "EXCHANGE" && from.entityClass !== "EXCHANGE") return "EXCHANGE_INFLOW";
  if (from.entityClass === "EXCHANGE" && to.entityClass !== "EXCHANGE") return "EXCHANGE_OUTFLOW";
  if (to.entityClass === "BRIDGE" && from.entityClass !== "BRIDGE") return "BRIDGE_INFLOW";
  if (from.entityClass === "BRIDGE" && to.entityClass !== "BRIDGE") return "BRIDGE_OUTFLOW";
  if (to.entityClass === "POOL" && from.entityClass !== "POOL") return "POOL_INFLOW";
  if (from.entityClass === "POOL" && to.entityClass !== "POOL") return "POOL_OUTFLOW";
  if (to.entityClass === "PROTOCOL" && from.entityClass !== "PROTOCOL") return "PROTOCOL_INFLOW";
  if (from.entityClass === "PROTOCOL" && to.entityClass !== "PROTOCOL") return "PROTOCOL_OUTFLOW";
  if (from.status === "UNKNOWN" || to.status === "UNKNOWN") return "UNATTRIBUTED";
  return "KNOWN_TO_KNOWN";
}

const touches = (event: WalletBehaviorEvent, entityId: string): boolean =>
  event.fromEntityId === entityId || event.toEntityId === entityId;

const counterparty = (event: WalletBehaviorEvent, entityId: string): string | undefined =>
  event.fromEntityId === entityId ? event.toEntityId : event.fromEntityId;

export function computeWalletBehaviorFeature(input: {
  readonly event: WalletBehaviorEvent;
  readonly entityId: string;
  readonly priorEvents: readonly WalletBehaviorEvent[];
  readonly minimumHistory?: number;
}): WalletBehaviorFeature {
  if (!touches(input.event, input.entityId)) throw new Error("event does not touch the entity");
  const minimumHistory = input.minimumHistory ?? 30;
  if (!Number.isInteger(minimumHistory) || minimumHistory < 2)
    throw new Error("minimumHistory must be an integer of at least two");
  const eventMs = new Date(input.event.eventTime).getTime();
  if (!Number.isFinite(eventMs)) throw new Error("event time is invalid");
  const history = input.priorEvents
    .filter(
      (event) => touches(event, input.entityId) && new Date(event.eventTime).getTime() < eventMs,
    )
    .sort(
      (left, right) =>
        left.eventTime.localeCompare(right.eventTime) || left.eventId.localeCompare(right.eventId),
    );
  const quantities = history.map((event) => new Decimal(event.quantity));
  let quantityZScore: string | null = null;
  if (quantities.length >= minimumHistory) {
    const mean = Decimal.sum(...quantities).div(quantities.length);
    const variance = Decimal.sum(...quantities.map((quantity) => quantity.minus(mean).pow(2))).div(
      quantities.length - 1,
    );
    const standardDeviation = variance.sqrt();
    if (!standardDeviation.isZero())
      quantityZScore = new Decimal(input.event.quantity)
        .minus(mean)
        .div(standardDeviation)
        .toString();
  }
  const last = history.at(-1);
  const dormancySeconds = last
    ? Math.max(0, (eventMs - new Date(last.eventTime).getTime()) / 1000)
    : null;
  const dayAgo = eventMs - 86_400_000;
  const prior24HourEventCount = history.filter(
    (event) => new Date(event.eventTime).getTime() >= dayAgo,
  ).length;
  const currentCounterparty = counterparty(input.event, input.entityId);
  const priorCounterparties = new Set(
    history.flatMap((event) => {
      const value = counterparty(event, input.entityId);
      return value === undefined ? [] : [value];
    }),
  );
  const identity = {
    featureVersion: 1 as const,
    entityId: input.entityId,
    eventId: input.event.eventId,
    asOf: input.event.eventTime,
    historyCount: history.length,
    quantityZScore,
    dormancySeconds,
    prior24HourEventCount,
    newCounterparty:
      currentCounterparty === undefined ? null : !priorCounterparties.has(currentCounterparty),
    evidenceEventIds: history.map((event) => event.eventId),
  };
  return { ...identity, contentHash: contentHash(identity) };
}

export function computeWalletBehaviorFeatureV2(input: {
  readonly event: WalletBehaviorEvent;
  readonly entityId: string;
  readonly priorEvents: readonly WalletBehaviorEvent[];
  readonly minimumHistory?: number;
}): WalletBehaviorFeatureV2 {
  if (!touches(input.event, input.entityId)) throw new Error("event does not touch the entity");
  const minimumHistory = input.minimumHistory ?? 30;
  if (!Number.isInteger(minimumHistory) || minimumHistory < 10)
    throw new Error("minimumHistory must be an integer of at least ten");
  const eventMs = new Date(input.event.eventTime).getTime();
  if (!Number.isFinite(eventMs)) throw new Error("event time is invalid");
  const history = input.priorEvents
    .filter(
      (event) => touches(event, input.entityId) && new Date(event.eventTime).getTime() < eventMs,
    )
    .sort(
      (left, right) =>
        left.eventTime.localeCompare(right.eventTime) || left.eventId.localeCompare(right.eventId),
    );
  const quantities = history.map((event) => new Decimal(event.quantity));
  const ready = history.length >= minimumHistory;
  const mean = ready ? Decimal.sum(...quantities).div(quantities.length) : null;
  const standardDeviation =
    ready && mean
      ? Decimal.sum(...quantities.map((quantity) => quantity.minus(mean).pow(2)))
          .div(quantities.length - 1)
          .sqrt()
      : null;
  const currentQuantity = new Decimal(input.event.quantity);
  const quantityZScore =
    mean !== null && standardDeviation !== null && !standardDeviation.isZero()
      ? currentQuantity.minus(mean).div(standardDeviation).toString()
      : null;
  const quantityPercentile = ready
    ? new Decimal(
        quantities.filter((quantity) => quantity.lessThanOrEqualTo(currentQuantity)).length,
      )
        .div(quantities.length)
        .toString()
    : null;
  const timestamps = history.map((event) => new Date(event.eventTime).getTime());
  const intervals = timestamps.slice(1).map((time, index) => time - (timestamps.at(index) ?? time));
  const currentInterval = timestamps.length === 0 ? null : eventMs - (timestamps.at(-1) ?? eventMs);
  let frequencyZScore: string | null = null;
  if (ready && intervals.length >= 2 && currentInterval !== null) {
    const intervalValues = intervals.map((value) => new Decimal(value));
    const intervalMean = Decimal.sum(...intervalValues).div(intervalValues.length);
    const intervalStd = Decimal.sum(
      ...intervalValues.map((value) => value.minus(intervalMean).pow(2)),
    )
      .div(intervalValues.length - 1)
      .sqrt();
    if (!intervalStd.isZero())
      frequencyZScore = new Decimal(currentInterval)
        .minus(intervalMean)
        .div(intervalStd)
        .negated()
        .toString();
  }
  const inbound = history.filter((event) => event.toEntityId === input.entityId);
  const outbound = history.filter((event) => event.fromEntityId === input.entityId);
  const inboundQuantity = Decimal.sum(0, ...inbound.map((event) => new Decimal(event.quantity)));
  const outboundQuantity = Decimal.sum(0, ...outbound.map((event) => new Decimal(event.quantity)));
  const counterparties = new Map<string, number>();
  for (const event of history) {
    const value = counterparty(event, input.entityId);
    if (value !== undefined) counterparties.set(value, (counterparties.get(value) ?? 0) + 1);
  }
  const maximumCounterpartyCount = Math.max(0, ...counterparties.values());
  const currentCounterparty = counterparty(input.event, input.entityId);
  const identity = {
    featureVersion: 2 as const,
    entityId: input.entityId,
    eventId: input.event.eventId,
    asOf: input.event.eventTime,
    status: ready ? ("READY" as const) : ("INSUFFICIENT_HISTORY" as const),
    minimumHistory,
    historyCount: history.length,
    quantityZScore,
    quantityPercentile,
    frequencyZScore,
    dormancySeconds: currentInterval === null ? null : currentInterval / 1000,
    inboundCount: inbound.length,
    outboundCount: outbound.length,
    inboundQuantity: inboundQuantity.toString(),
    outboundQuantity: outboundQuantity.toString(),
    netFlowQuantity: inboundQuantity.minus(outboundQuantity).toString(),
    counterpartyConcentration:
      history.length === 0
        ? null
        : new Decimal(maximumCounterpartyCount).div(history.length).toString(),
    newCounterparty:
      currentCounterparty === undefined ? null : !counterparties.has(currentCounterparty),
    evidenceEventIds: history.map((event) => event.eventId),
  };
  return { ...identity, contentHash: contentHash(identity) };
}
