import { describe, expect, it } from "vitest";
import {
  CapitalEventSchema,
  EnrichmentClaimSchema,
  EntityLabelRegistry,
  EntitySchema,
  ProvenanceSchema,
  computeExchangeFlowAnomalies,
  type CapitalEvent,
} from "../src/index.js";

const hash = `sha256:${"a".repeat(64)}`;
const assetId = "asset_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const exchangeId = "entity_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const walletId = "entity_01ARZ3NDEKTSV4RRFFQ69G5FAX";

function event(
  suffix: string,
  eventTime: string,
  usdValueAtEvent: string,
  direction: "INFLOW" | "OUTFLOW" = "INFLOW",
): CapitalEvent {
  return CapitalEventSchema.parse({
    eventId: `event_01ARZ3NDEKTSV4RRFFQ69G5F${suffix}`,
    eventTime,
    ingestTime: "2026-01-01T05:01:00.000Z",
    source: "fixture",
    chain: "solana",
    eventType: "TRANSFER",
    assetId,
    quantity: usdValueAtEvent,
    usdValueAtEvent,
    fromEntityId: direction === "INFLOW" ? walletId : exchangeId,
    toEntityId: direction === "INFLOW" ? exchangeId : walletId,
    confidence: 0.9,
    rawRef: hash,
    schemaVersion: "1",
  });
}

describe("capital-flow contracts", () => {
  it("keeps verified attribution distinct from unsupported labels", () => {
    expect(() =>
      EntitySchema.parse({
        entityId: exchangeId,
        entityType: "EXCHANGE",
        labels: ["Example exchange"],
        addresses: ["address"],
        attribution: "VERIFIED",
        confidence: 0.95,
        firstSeen: "2026-01-01T00:00:00.000Z",
        lastSeen: "2026-01-02T00:00:00.000Z",
        evidence: [
          {
            source: "vendor",
            rawRef: hash,
            observedAt: "2026-01-01T00:00:00.000Z",
            method: "HEURISTIC",
          },
        ],
        schemaVersion: "1",
      }),
    ).toThrow(/verified evidence/);
  });

  it("rejects capital events with no entity endpoint", () => {
    const valid = event("AY", "2026-01-01T04:30:00.000Z", "10");
    const invalid = { ...valid, fromEntityId: undefined, toEntityId: undefined };
    expect(() => CapitalEventSchema.parse(invalid)).toThrow(/entity endpoint/);
  });

  it("captures raw provenance independently from enrichment claims", () => {
    const provenance = ProvenanceSchema.parse({
      sourceProvider: "fixture-chain",
      sourceType: "FIXTURE",
      sourceId: "transfer-1",
      observedAt: "2026-01-01T00:00:00.000Z",
      ingestedAt: "2026-01-01T00:00:01.000Z",
      rawObjectRef: hash,
      schemaVersion: "1",
      parserVersion: "1",
      licenseTag: "fixture-only",
    });
    const claim = EnrichmentClaimSchema.parse({
      claimId: "claim_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      subjectId: walletId,
      claimType: "exchange-affiliation",
      value: "example-exchange",
      provider: "fixture-entity-intel",
      confidence: 0.75,
      evidenceRefs: [hash],
      validFrom: "2026-01-01T00:00:00.000Z",
      validTo: "2026-01-02T00:00:00.000Z",
      retrievedAt: "2026-01-01T00:00:02.000Z",
      schemaVersion: "1",
    });
    expect(provenance.sourceProvider).toBe("fixture-chain");
    expect(claim.provider).toBe("fixture-entity-intel");
  });

  it("queries immutable point-in-time entity labels by confidence", () => {
    const registry = new EntityLabelRegistry();
    const base = {
      entityType: "EXCHANGE" as const,
      labels: ["Example exchange"],
      addresses: ["address-1"],
      attribution: "UNKNOWN" as const,
      firstSeen: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-01-31T00:00:00.000Z",
      evidence: [],
      schemaVersion: "1",
    };
    const lower = EntitySchema.parse({ ...base, entityId: exchangeId, confidence: 0.5 });
    const higher = EntitySchema.parse({
      ...base,
      entityId: "entity_01ARZ3NDEKTSV4RRFFQ69G5FAY",
      confidence: 0.8,
    });
    registry.register(lower);
    registry.register(higher);
    expect(registry.lookupAddress("address-1", "2026-01-15T00:00:00.000Z")).toEqual([
      higher,
      lower,
    ]);
    expect(registry.lookupAddress("address-1", "2026-02-01T00:00:00.000Z")).toEqual([]);
    expect(() => registry.register({ ...lower, confidence: 0.9 })).toThrow(/immutable/);
  });
});

describe("exchange-flow anomaly features", () => {
  const query = {
    assetId,
    exchangeEntityIds: [exchangeId],
    asOf: "2026-01-01T05:00:00.000Z",
    windowSeconds: 3600,
    baselineWindows: 4,
    minimumBaselineWindows: 4,
  } as const;

  it("computes directional point-in-time z-scores and evidence", () => {
    const events = [
      event("AZ", "2026-01-01T04:30:00.000Z", "50"),
      event("B0", "2026-01-01T03:30:00.000Z", "10"),
      event("B1", "2026-01-01T02:30:00.000Z", "20"),
      event("B2", "2026-01-01T01:30:00.000Z", "10"),
      event("B3", "2026-01-01T00:30:00.000Z", "20"),
      event("B4", "2026-01-01T04:15:00.000Z", "7", "OUTFLOW"),
    ];
    const [inflow, outflow] = computeExchangeFlowAnomalies(events, query);
    expect(inflow.currentUsdValue).toBe("50");
    expect(inflow.baselineMeanUsdValue).toBe("15");
    expect(inflow.baselineStandardDeviationUsdValue).toBe("5");
    expect(inflow.zScore).toBe("7");
    expect(inflow.evidenceEventIds).toEqual([events[0]?.eventId]);
    expect(outflow.currentUsdValue).toBe("7");
    expect(outflow.zScore).toBeNull();
  });

  it("excludes future events and produces order-independent identity", () => {
    const inputs = [
      event("B5", "2026-01-01T04:30:00.000Z", "25"),
      event("B6", "2026-01-01T03:30:00.000Z", "10"),
      event("B7", "2026-01-01T02:30:00.000Z", "20"),
      event("B8", "2026-01-01T01:30:00.000Z", "10"),
      event("B9", "2026-01-01T00:30:00.000Z", "20"),
      event("BA", "2026-01-01T05:00:01.000Z", "999999"),
    ];
    const [first] = computeExchangeFlowAnomalies(inputs, query);
    const [second] = computeExchangeFlowAnomalies([...inputs].reverse(), query);
    expect(first.currentUsdValue).toBe("25");
    expect(first.contentHash).toBe(second.contentHash);
  });

  it("rejects invalid research windows", () => {
    expect(() => computeExchangeFlowAnomalies([], { ...query, windowSeconds: 0 })).toThrow(
      /windowSeconds/,
    );
    expect(() => computeExchangeFlowAnomalies([], { ...query, minimumBaselineWindows: 1 })).toThrow(
      /minimumBaselineWindows/,
    );
  });
});
