import { describe, expect, it } from "vitest";
import { normalizeSolanaTransfers } from "@autonomous-trading-lab/solana-normalization";
import type { RawBlock } from "@autonomous-trading-lab/provider-sdk";
import { buildEvidencePacket } from "../src/index.js";

const block: RawBlock = {
  providerRef: "solana:slot:1:block",
  chain: "solana",
  sequence: "1",
  sourceTimestamp: "2026-01-01T00:00:00.000Z",
  payload: {
    transactions: [
      {
        meta: { err: null },
        transaction: {
          signatures: ["signature"],
          message: {
            instructions: [
              {
                program: "system",
                parsed: {
                  type: "transfer",
                  info: { source: "source", destination: "destination", lamports: 1 },
                },
              },
            ],
          },
        },
      },
    ],
  },
};

describe("evidence packet", () => {
  it("links deterministic features and raw provenance to human review", () => {
    const normalized = normalizeSolanaTransfers(block, "2026-01-01T00:00:01.000Z");
    const detectedEvent = normalized.events[0];
    if (!detectedEvent) throw new Error("fixture event missing");
    const input = {
      generatedAt: "2026-01-01T00:01:00.000Z",
      detectedEvent,
      provenance: normalized.provenance,
      entities: [],
      features: [
        {
          name: "exchange-inflow-z-score",
          algorithmVersion: "1",
          inputEventIds: [detectedEvent.eventId],
          value: "3.2",
        },
      ],
      historicalAnalogueCount: 12,
      forwardOutcomeSummary: { "1h": "0.7", "24h": null },
      contradictions: ["derivatives confirmation unavailable"],
      dataQuality: "PARTIAL" as const,
      confidence: 0.6,
    };
    const first = buildEvidencePacket(input);
    const second = buildEvidencePacket(structuredClone(input));
    expect(first).toEqual(second);
    expect(first.action).toBe("HUMAN_REVIEW");
    expect(first.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects evidence disconnected from the detected raw object", () => {
    const normalized = normalizeSolanaTransfers(block, "2026-01-01T00:00:01.000Z");
    const detectedEvent = normalized.events[0];
    if (!detectedEvent) throw new Error("fixture event missing");
    expect(() =>
      buildEvidencePacket({
        generatedAt: "2026-01-01T00:01:00.000Z",
        detectedEvent,
        provenance: {
          ...normalized.provenance,
          rawObjectRef: `sha256:${"f".repeat(64)}`,
        },
        entities: [],
        features: [],
        historicalAnalogueCount: 0,
        forwardOutcomeSummary: {},
        contradictions: [],
        dataQuality: "DEGRADED",
        confidence: 0,
      }),
    ).toThrow(/not linked/);
  });
});
