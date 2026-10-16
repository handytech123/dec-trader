import { describe, expect, it } from "vitest";
import { deterministicDomainId } from "@autonomous-trading-lab/domain";
import { createResponseFailureStrategy } from "../src/index.js";

const strategyVersionId = deterministicDomainId("strategy_version", "response-failure-v1");
const strategy = createResponseFailureStrategy({
  strategyVersionId,
  experimentId: deterministicDomainId("experiment", "response-failure-v1"),
  inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  outputMint: "So11111111111111111111111111111111111111112",
  requestedInputAtomic: "1000000",
  minimumExpectedNetBps: 10,
  minimumEvidenceSampleSize: 100,
  proposalLifetimeSeconds: 60,
});
const context = {
  evaluationId: deterministicDomainId("evaluation", "response-failure"),
  evaluatedAt: "2026-10-12T00:00:00.000Z",
  mode: "SHADOW" as const,
  portfolioSnapshotId: deterministicDomainId("portfolio", "response-failure"),
  featureSnapshotId: deterministicDomainId("feature", "response-failure"),
};

describe("CFIE response-failure candidate", () => {
  it("abstains while research reports no supported edge", () => {
    expect(
      strategy.evaluate({
        context,
        features: {
          marketResponseLabel: "HEAVY_SELLING_LIMITED_DOWNSIDE",
          evidenceVerdict: "NO_SUPPORTED_EDGE",
          evidenceSampleSize: 5330,
          expectedNetBps: 20,
          replayReproducibility: 1,
        },
      }),
    ).toEqual([]);
  });

  it("emits a bounded proposal only when every evidence gate passes", () => {
    const proposals = strategy.evaluate({
      context,
      features: {
        marketResponseLabel: "HEAVY_SELLING_LIMITED_DOWNSIDE",
        evidenceVerdict: "SUPPORTED",
        evidenceSampleSize: 500,
        expectedNetBps: 20,
        replayReproducibility: 0.99,
      },
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      strategyVersionId,
      thesisCode: "HEAVY_SELLING_LIMITED_DOWNSIDE_V1",
      requestedInputAtomic: "1000000",
    });
  });
});
