import { describe, expect, it } from "vitest";
import { buildCfieResearchFeatures } from "../src/research-snapshot.js";

describe("CFIE research feature snapshot", () => {
  it("derives point-in-time returns, depth retention, and evidence", () => {
    expect(
      buildCfieResearchFeatures({
        observedAt: "2026-10-13T22:00:00.000Z",
        referencePriceUsd: 102,
        referencePrice5mAgoUsd: 100,
        referenceMean1hUsd: 101,
        referenceConfidence: 0.95,
        uncertaintyBps: 12,
        marketRegime: "RISING",
        realizedVolatilityPct: 0.2,
        protocolFlowZScore: 2.5,
        flowEventCount: 12,
        spreadBps: 10,
        orderBookImbalance: 0.25,
        depthChangePct: -20,
        reactionReturnPct: 0.15,
        evidenceClassification: "SUPPORTED",
        evidenceSampleSize: 120,
        expectedNetBps: 18,
        replayReproducibility: 0.99,
      }),
    ).toMatchObject({
      return5mBps: 200,
      depthRetentionScore: 0.8,
      recoveryBps: 15,
      protocolFlowZScore: 2.5,
      flowMagnitudeZScore: 2.5,
      evidenceVerdict: "SUPPORTED",
      evidenceSampleSize: 120,
      featureCoverage: 1,
    });
  });

  it("preserves missing inputs as null and insufficient evidence", () => {
    expect(
      buildCfieResearchFeatures({
        observedAt: "2026-10-13T22:00:00.000Z",
        referencePriceUsd: 100,
        referencePrice5mAgoUsd: null,
        referenceMean1hUsd: null,
        referenceConfidence: 0.8,
        uncertaintyBps: null,
        marketRegime: null,
        realizedVolatilityPct: null,
        protocolFlowZScore: null,
        flowEventCount: null,
        spreadBps: null,
        orderBookImbalance: null,
        depthChangePct: null,
        reactionReturnPct: null,
        evidenceClassification: null,
        evidenceSampleSize: 0,
        expectedNetBps: null,
        replayReproducibility: null,
      }),
    ).toMatchObject({
      marketRegime: "INSUFFICIENT_DATA",
      return5mBps: null,
      protocolFlowZScore: null,
      evidenceVerdict: "INSUFFICIENT_DATA",
      featureCoverage: 0,
    });
  });
});
