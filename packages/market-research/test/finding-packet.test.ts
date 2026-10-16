import { describe, expect, it } from "vitest";
import { finalizeResearchFindingPacket } from "../src/finding-packet.js";

const hash = `sha256:${"a".repeat(64)}` as const;

describe("research finding packets", () => {
  it("content-addresses negative results with required audit context", () => {
    const body = {
      packetVersion: 1 as const,
      hypothesisId: "H1",
      protocolId: "protocol_test",
      runId: "run_test",
      generatedAt: "2026-01-01T00:00:00.000Z",
      classification: "INSUFFICIENT_DATA" as const,
      codeHash: hash,
      datasetHash: hash,
      configHash: hash,
      observationCount: 20,
      episodeCount: null,
      attributionQuality: "UNKNOWN_RETAINED",
      effectSizes: [],
      confidenceIntervals: [],
      significance: { hypothesisCount: 4, falseDiscoveryRate: 0.05, correction: "BH" },
      dependenceDiagnostics: null,
      baselinesAndFalsification: {},
      developmentResult: {},
      holdoutResult: { accessed: false },
      frictionSensitivity: { status: "NOT_EVALUATED" },
      contradictoryEvidence: [],
      limitations: ["sample immature"],
      humanReviewAction: "Continue collection; do not promote.",
    };
    expect(finalizeResearchFindingPacket(body)).toEqual(finalizeResearchFindingPacket(body));
  });

  it("rejects incomplete or invalid research audit metadata", () => {
    const valid = {
      packetVersion: 1 as const,
      hypothesisId: "H1",
      protocolId: "protocol_test",
      runId: "run_test",
      generatedAt: "2026-01-01T00:00:00.000Z",
      classification: "NOT_SUPPORTED" as const,
      codeHash: hash,
      datasetHash: hash,
      configHash: hash,
      observationCount: 1,
      episodeCount: null,
      attributionQuality: "UNKNOWN_RETAINED",
      effectSizes: [],
      confidenceIntervals: [],
      significance: { hypothesisCount: 1, falseDiscoveryRate: 0.05, correction: "BH" },
      dependenceDiagnostics: null,
      baselinesAndFalsification: {},
      developmentResult: {},
      holdoutResult: { accessed: false },
      frictionSensitivity: {},
      contradictoryEvidence: [],
      limitations: [],
      humanReviewAction: "Do not promote.",
    };
    expect(() => finalizeResearchFindingPacket({ ...valid, observationCount: -1 })).toThrow(
      /observation count/,
    );
    expect(() =>
      finalizeResearchFindingPacket({
        ...valid,
        significance: { ...valid.significance, hypothesisCount: -1 },
      }),
    ).toThrow(/hypothesis count/);
    expect(() =>
      finalizeResearchFindingPacket({
        ...valid,
        significance: { ...valid.significance, falseDiscoveryRate: 0.2 },
      }),
    ).toThrow(/FDR/);
    expect(() => finalizeResearchFindingPacket({ ...valid, humanReviewAction: " " })).toThrow(
      /human-review/,
    );
  });
});
