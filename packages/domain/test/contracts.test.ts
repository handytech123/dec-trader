import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  contentHash,
  entryEvaluationMode,
  EnvironmentConfigSchema,
  TradeProposalSchema,
} from "../src/index.js";

const proposal = {
  proposalId: "proposal_01K5J8R4K4F8D8P9Q2Z2T2H3M4",
  strategyVersionId: "strategy_01K5J8R4K4F8D8P9Q2Z2T2H3M4",
  experimentId: "experiment_01K5J8R4K4F8D8P9Q2Z2T2H3M4",
  side: "BUY",
  inputMint: "11111111111111111111111111111111",
  outputMint: "So11111111111111111111111111111111111111112",
  requestedInputAtomic: "1000000",
  thesisCode: "MOMENTUM_BASELINE",
  signalValues: { return5m: "0.012" },
  validUntil: "2026-09-19T18:00:00.000Z",
};

describe("domain contracts", () => {
  it("accepts a narrow proposal", () => {
    expect(TradeProposalSchema.parse(proposal)).toEqual(proposal);
  });

  it.each([
    "walletAddress",
    "serializedTransaction",
    "programId",
    "destinationAccount",
    "slippageBps",
  ])("rejects forbidden authority field %s", (field) => {
    expect(() => TradeProposalSchema.parse({ ...proposal, [field]: "forbidden" })).toThrow();
  });

  it("rejects live Phase 0 configuration", () => {
    expect(() => {
      EnvironmentConfigSchema.parse({
        ATL_ENVIRONMENT: "live",
        ATL_SYSTEM_MODE: "LIVE_ARMED",
        ATL_NETWORK_ACCESS: "disabled",
        ATL_LOG_LEVEL: "info",
      });
    }).toThrow();
  });

  it("does not make HALTED entry-capable", () => {
    expect(entryEvaluationMode("HALTED")).toBeNull();
  });

  it.each([
    ["OFFLINE_RESEARCH", "BACKTEST"],
    ["SHADOW", "SHADOW"],
    ["PAPER", "PAPER"],
    ["LIVE_ARMED", "LIVE"],
  ] as const)("maps system mode %s to evaluation mode %s", (systemMode, evaluationMode) => {
    expect(entryEvaluationMode(systemMode)).toBe(evaluationMode);
  });

  it("canonicalizes key order before hashing", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(contentHash({ b: 2, a: 1 })).toBe(contentHash({ a: 1, b: 2 }));
  });

  it("canonicalizes arrays and bigint values", () => {
    expect(canonicalJson([2n, { b: 1, a: 0 }])).toBe('["2",{"a":0,"b":1}]');
  });

  it.each([undefined, Number.POSITIVE_INFINITY])("rejects noncanonical value %s", (value) => {
    expect(() => canonicalJson(value)).toThrow();
  });
});
