import { describe, expect, it } from "vitest";
import {
  CapitalEventSchema,
  auditVerifiedEntityRegistry,
  classifyCapitalFlowDirection,
  computeWalletBehaviorFeature,
  computeWalletBehaviorFeatureV2,
  resolveVerifiedAddress,
  type CapitalEvent,
  type VerifiedEntityAddress,
} from "../src/index.js";

const hash = `sha256:${"a".repeat(64)}` as const;
const address = "11111111111111111111111111111111";
const entityId = "entity_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const counterpartyId = "entity_01ARZ3NDEKTSV4RRFFQ69G5FAY";

const verified = (overrides: Partial<VerifiedEntityAddress> = {}): VerifiedEntityAddress => ({
  address,
  entityType: "EXCHANGE",
  label: "Example exchange",
  source: "official-source",
  sourceUrl: "https://example.com/registry",
  evidenceHash: hash,
  validFrom: "2026-01-01T00:00:00.000Z",
  retrievedAt: "2026-01-02T00:00:00.000Z",
  schemaVersion: "1",
  ...overrides,
});

describe("wallet behavior v2", () => {
  it("fails closed below minimum history and computes point-in-time anomalies when ready", () => {
    const priorEvents = Array.from({ length: 30 }, (_, index) => ({
      eventId: `event-${String(index)}`,
      eventTime: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      quantity: String(index + 1),
      fromEntityId: index % 2 === 0 ? "wallet" : "counterparty",
      toEntityId: index % 2 === 0 ? "counterparty" : "wallet",
    }));
    const event = {
      eventId: "current",
      eventTime: new Date(Date.UTC(2026, 0, 2)).toISOString(),
      quantity: "100",
      fromEntityId: "wallet",
      toEntityId: "new-counterparty",
    };
    expect(
      computeWalletBehaviorFeatureV2({
        event,
        entityId: "wallet",
        priorEvents: priorEvents.slice(0, 9),
      }).status,
    ).toBe("INSUFFICIENT_HISTORY");
    const feature = computeWalletBehaviorFeatureV2({ event, entityId: "wallet", priorEvents });
    expect(feature).toMatchObject({
      featureVersion: 2,
      status: "READY",
      historyCount: 30,
      inboundCount: 15,
      outboundCount: 15,
      newCounterparty: true,
    });
    expect(Number(feature.quantityPercentile)).toBe(1);
    expect(Number(feature.quantityZScore)).toBeGreaterThan(3);
  });
});

const event = (index: number, quantity = "10", destination = counterpartyId): CapitalEvent =>
  CapitalEventSchema.parse({
    eventId: `event_${"0".repeat(24)}${String(index).padStart(2, "0")}`,
    eventTime: new Date(Date.UTC(2026, 0, 3, index)).toISOString(),
    ingestTime: new Date(Date.UTC(2026, 0, 3, index, 1)).toISOString(),
    source: "fixture",
    chain: "solana",
    eventType: "TRANSFER",
    assetId: "asset_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    quantity,
    usdValueAtEvent: null,
    fromEntityId: entityId,
    toEntityId: destination,
    confidence: 1,
    rawRef: hash,
    schemaVersion: "1",
  });

describe("entity intelligence", () => {
  it("resolves only evidence available at the point in time", () => {
    expect(resolveVerifiedAddress(address, "2026-01-01T12:00:00.000Z", [verified()]).status).toBe(
      "UNKNOWN",
    );
    const resolution = resolveVerifiedAddress(address, "2026-01-02T12:00:00.000Z", [verified()]);
    expect(resolution.status).toBe("VERIFIED");
    expect(resolution.entityClass).toBe("EXCHANGE");
  });

  it("fails closed when overlapping verified sources disagree", () => {
    const resolution = resolveVerifiedAddress(address, "2026-01-02T12:00:00.000Z", [
      verified(),
      verified({ entityType: "BRIDGE", label: "Example bridge", source: "second-source" }),
    ]);
    expect(resolution.status).toBe("CONFLICT");
    const audit = auditVerifiedEntityRegistry([
      verified(),
      verified({
        entityType: "BRIDGE",
        label: "Example bridge",
        source: "second-source",
        validFrom: "2026-01-01T01:00:00.000Z",
      }),
    ]);
    expect(audit.safeToImport).toBe(false);
    expect(audit.conflictingOverlapCount).toBe(1);
    expect(
      classifyCapitalFlowDirection(
        { ...resolution, address: "from" },
        resolveVerifiedAddress("unknown", "2026-01-02T12:00:00.000Z", []),
      ),
    ).toBe("AMBIGUOUS");
  });

  it("classifies exchange inflows without inventing unknown identities", () => {
    const exchange = resolveVerifiedAddress(address, "2026-01-02T12:00:00.000Z", [verified()]);
    const unknown = resolveVerifiedAddress("unknown", "2026-01-02T12:00:00.000Z", []);
    expect(classifyCapitalFlowDirection(unknown, exchange)).toBe("EXCHANGE_INFLOW");
    expect(classifyCapitalFlowDirection(unknown, unknown)).toBe("UNATTRIBUTED");
  });

  it("classifies bridge, pool, protocol, and known-to-known directions", () => {
    const resolution = (entityClass: "BRIDGE" | "POOL" | "PROTOCOL") => ({
      address: entityClass,
      asOf: "2026-01-02T12:00:00.000Z",
      status: "VERIFIED" as const,
      entityClass,
      label: entityClass,
      evidenceHashes: [hash],
      sources: ["fixture"],
    });
    const unknown = resolveVerifiedAddress("unknown", "2026-01-02T12:00:00.000Z", []);
    expect(classifyCapitalFlowDirection(unknown, resolution("BRIDGE"))).toBe("BRIDGE_INFLOW");
    expect(classifyCapitalFlowDirection(resolution("BRIDGE"), unknown)).toBe("BRIDGE_OUTFLOW");
    expect(classifyCapitalFlowDirection(unknown, resolution("POOL"))).toBe("POOL_INFLOW");
    expect(classifyCapitalFlowDirection(resolution("POOL"), unknown)).toBe("POOL_OUTFLOW");
    expect(classifyCapitalFlowDirection(unknown, resolution("PROTOCOL"))).toBe("PROTOCOL_INFLOW");
    expect(classifyCapitalFlowDirection(resolution("PROTOCOL"), unknown)).toBe("PROTOCOL_OUTFLOW");
    expect(classifyCapitalFlowDirection(resolution("POOL"), resolution("POOL"))).toBe(
      "KNOWN_TO_KNOWN",
    );
  });

  it("audits single-source registries and merges agreeing evidence", () => {
    const second = verified({
      source: "second-source",
      evidenceHash: `sha256:${"b".repeat(64)}`,
      validFrom: "2026-01-01T01:00:00.000Z",
    });
    const resolved = resolveVerifiedAddress(address, "2026-01-02T12:00:00.000Z", [
      verified(),
      second,
    ]);
    expect(resolved.status).toBe("VERIFIED");
    expect(resolved.sources).toEqual(["official-source", "second-source"]);
    expect(auditVerifiedEntityRegistry([verified()]).issues[0]?.severity).toBe("WARNING");
    expect(auditVerifiedEntityRegistry([]).safeToImport).toBe(true);
  });

  it("computes wallet behavior from strictly prior events", () => {
    const prior = Array.from({ length: 30 }, (_, index) => event(index, String(index + 1)));
    const current = event(31, "100", "entity_01ARZ3NDEKTSV4RRFFQ69G5FAZ");
    const future = event(32, "999999");
    const feature = computeWalletBehaviorFeature({
      event: current,
      entityId,
      priorEvents: [...prior, future],
    });
    expect(feature.historyCount).toBe(30);
    expect(Number(feature.quantityZScore)).toBeGreaterThan(5);
    expect(feature.dormancySeconds).toBe(7200);
    expect(feature.prior24HourEventCount).toBe(23);
    expect(feature.newCounterparty).toBe(true);
    expect(feature.evidenceEventIds).not.toContain(future.eventId);
  });

  it("fails closed for invalid wallet requests and insufficient variance", () => {
    const current = event(3, "10");
    expect(() =>
      computeWalletBehaviorFeature({
        event: current,
        entityId: "entity_01ARZ3NDEKTSV4RRFFQ69G5FAW",
        priorEvents: [],
      }),
    ).toThrow(/does not touch/);
    expect(() =>
      computeWalletBehaviorFeature({
        event: current,
        entityId,
        priorEvents: [],
        minimumHistory: 1,
      }),
    ).toThrow(/at least two/);
    const feature = computeWalletBehaviorFeature({
      event: current,
      entityId,
      priorEvents: [event(0, "10"), event(1, "10")],
      minimumHistory: 2,
    });
    expect(feature.quantityZScore).toBeNull();
    expect(feature.newCounterparty).toBe(false);
  });
});
