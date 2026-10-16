import { describe, expect, it } from "vitest";
import { bindStrategyFindingPacket } from "../src/research-evidence.js";

describe("strategy finding-packet binding", () => {
  it("binds an exact hypothesis with explicit strategy evidence", () => {
    expect(
      bindStrategyFindingPacket(
        {
          packetVersion: 1,
          hypothesisId: "CFIE_STRATEGY:FLOW_MOMENTUM:V1",
          classification: "SUPPORTED",
          observationCount: 120,
          developmentResult: {
            strategyEvidence: { expectedNetBps: 18, replayReproducibility: 0.97 },
          },
        },
        "CFIE_STRATEGY:FLOW_MOMENTUM:V1",
      ),
    ).toEqual({
      classification: "SUPPORTED",
      sampleSize: 120,
      expectedNetBps: 18,
      replayReproducibility: 0.97,
      state: "BOUND",
    });
  });

  it("fails closed for a different strategy's packet", () => {
    expect(
      bindStrategyFindingPacket(
        { packetVersion: 1, hypothesisId: "OTHER" },
        "CFIE_STRATEGY:FLOW_MOMENTUM:V1",
      ),
    ).toMatchObject({ state: "HYPOTHESIS_MISMATCH", classification: null });
  });

  it("does not infer trading metrics from a generic supported result", () => {
    expect(
      bindStrategyFindingPacket(
        {
          packetVersion: 1,
          hypothesisId: "H1",
          classification: "SUPPORTED",
          observationCount: 200,
          developmentResult: { cells: [{ significant: true }] },
        },
        "H1",
      ),
    ).toEqual({
      classification: "SUPPORTED",
      sampleSize: 200,
      expectedNetBps: null,
      replayReproducibility: null,
      state: "BOUND",
    });
  });
});
