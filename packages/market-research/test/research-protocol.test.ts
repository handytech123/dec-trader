import { describe, expect, it } from "vitest";
import { finalizeResearchProtocol, ResearchProtocolSchema } from "../src/index.js";

const codeHash = `sha256:${"a".repeat(64)}` as const;

const candidate = {
  protocolId: "protocol_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  name: "CFIE Research Phase 1",
  version: "1",
  objective: "Test whether point-in-time observable SOL capital flows contain forward information.",
  families: [
    {
      family: "TRANSFER_MAGNITUDE",
      hypothesis: "Extreme transfer magnitude changes outcomes.",
      features: ["transfer_z_score"],
      thresholds: ["1", "2", "3", "4"],
    },
    {
      family: "DIRECTION",
      hypothesis: "Attributed direction changes outcomes.",
      features: ["entity_direction"],
      thresholds: [],
    },
    {
      family: "WALLET_BEHAVIOR",
      hypothesis: "Wallet-relative anomalies change outcomes.",
      features: ["wallet_size_z", "dormancy"],
      thresholds: [],
    },
    {
      family: "MARKET_REACTION",
      hypothesis: "Flow and microstructure interact.",
      features: ["imbalance", "spread", "depth"],
      thresholds: [],
    },
    {
      family: "CONDITIONAL_COMBINATION",
      hypothesis: "Locked combinations outperform components.",
      features: ["locked_combination"],
      thresholds: [],
    },
    {
      family: "FALSIFICATION",
      hypothesis: "Effects survive required controls.",
      features: ["control_comparison"],
      thresholds: [],
    },
  ] as const,
  horizons: ["1m", "5m", "15m", "1h", "6h", "24h"] as const,
  requiredControls: [
    "RANDOMIZED_TIMESTAMPS",
    "UNCONDITIONAL_SOL",
    "BTC_MARKET",
    "REGIME_STRATIFICATION",
    "REMOVE_LARGEST_FIVE",
    "WALK_FORWARD_HOLDOUT",
    "TRADING_COSTS",
  ] as const,
  multipleTestingMethod: "BENJAMINI_HOCHBERG" as const,
  falseDiscoveryRate: 0.05,
  minimumSampleSize: 100,
  holdoutFraction: 0.2,
  seed: "20261003",
  datasetCutoff: "2026-10-03T00:00:00.000Z",
  frozenAt: "2026-10-03T00:00:00.000Z",
  codeHash,
};

describe("research protocol", () => {
  it("freezes all six families and falsification controls under a content hash", () => {
    const protocol = finalizeResearchProtocol(candidate);
    expect(protocol.families).toHaveLength(6);
    expect(protocol.requiredControls).toContain("RANDOMIZED_TIMESTAMPS");
    expect(() => ResearchProtocolSchema.parse({ ...protocol, minimumSampleSize: 30 })).toThrow(
      /content hash/,
    );
  });

  it("rejects duplicate or missing research families", () => {
    const duplicated = [...candidate.families.slice(0, 5), candidate.families[0]];
    expect(() => finalizeResearchProtocol({ ...candidate, families: duplicated })).toThrow(
      /family/,
    );
  });

  it("freezes the focused protocol-flow and falsification profile", () => {
    const protocol = finalizeResearchProtocol({
      ...candidate,
      protocolId: "protocol_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      name: "CFIE PumpSwap Protocol-Flow Research",
      families: [
        {
          family: "PROTOCOL_FLOW",
          hypothesis: "Point-in-time PumpSwap fee flow changes subsequent SOL returns.",
          features: ["pumpswap_fee_event_count_z_v1"],
          thresholds: ["prior_windows>=12", "z>=2", "z>=3", "z<=-2"],
        },
        {
          family: "FALSIFICATION",
          hypothesis: "Any effect must survive registered controls.",
          features: ["adjusted_p_value_v1"],
          thresholds: ["adjusted_p<=0.05", "minimum_sample>=100"],
        },
      ],
    });
    expect(protocol.families.map((family) => family.family)).toEqual([
      "PROTOCOL_FLOW",
      "FALSIFICATION",
    ]);
  });
});
