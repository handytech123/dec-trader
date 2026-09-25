import { describe, expect, it } from "vitest";
import {
  momentumBaseline,
  quorumEnsemble,
  walletConfirmedMomentum,
  type ReferenceSignal,
} from "../src/index.js";

const signal: ReferenceSignal = {
  proposalId: "proposal_01K5J8R4K4F8D8P9Q2Z2T2H3M4",
  strategyVersionId: "strategy_01K5J8R4K4F8D8P9Q2Z2T2H3M4",
  experimentId: "experiment_01K5J8R4K4F8D8P9Q2Z2T2H3M4",
  inputMint: "11111111111111111111111111111111",
  outputMint: "So11111111111111111111111111111111111111112",
  requestedInputAtomic: "1000000",
  validUntil: "2026-01-01T00:01:00.000Z",
  return5m: 0.02,
  volumeAcceleration: 1.5,
  liquidityUsd: 75_000,
  walletQuality: 0.8,
};

describe("reference strategies", () => {
  it("keeps momentum rules transparent", () => {
    expect(momentumBaseline(signal)).toHaveLength(1);
    expect(momentumBaseline({ ...signal, liquidityUsd: 49_999 })).toEqual([]);
  });
  it("requires independent wallet confirmation", () => {
    expect(walletConfirmedMomentum(signal)).toHaveLength(1);
    expect(walletConfirmedMomentum({ ...signal, walletQuality: 0.69 })).toEqual([]);
  });
  it("requires configured quorum", () => {
    const proposal = momentumBaseline(signal);
    expect(quorumEnsemble([proposal, proposal], 2)).toEqual(proposal);
    expect(quorumEnsemble([proposal, []], 2)).toEqual([]);
    expect(() => quorumEnsemble([], 0)).toThrow("positive integer");
  });
});
