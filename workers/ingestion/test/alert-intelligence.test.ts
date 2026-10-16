import { describe, expect, it } from "vitest";
import {
  classifyAlertIntelligence,
  summarizeAlertIntelligence,
} from "../src/alert-intelligence.js";

describe("filtered alert intelligence", () => {
  it("classifies unusual exchange inflows without inventing the source identity", () => {
    expect(
      classifyAlertIntelligence({
        toEntityType: "EXCHANGE",
        toLabel: "Verified Exchange",
        priorTransferCount: 50,
        quantityZScore: 4.2,
        dormantDays: 40,
        finalized: true,
        normalized: true,
        outcomeCount: 1,
      }),
    ).toMatchObject({
      direction: "EXCHANGE_INFLOW",
      protocolAction: "NONE",
      walletAnomaly: "EXTREME",
      qualityScore: 90,
    });
  });

  it("decodes bridge and lending context only from verified labels and classes", () => {
    expect(
      classifyAlertIntelligence({
        toEntityType: "BRIDGE",
        toLabel: "Wormhole Core Bridge",
        priorTransferCount: 2,
        finalized: true,
        normalized: true,
        outcomeCount: 0,
      }),
    ).toMatchObject({
      direction: "INTO_BRIDGE",
      protocolAction: "BRIDGE_INTERACTION",
      walletAnomaly: "INSUFFICIENT_HISTORY",
    });
    expect(
      classifyAlertIntelligence({
        toEntityType: "PROTOCOL",
        toLabel: "Jupiter Lend Borrow",
        priorTransferCount: 20,
        finalized: true,
        normalized: true,
        outcomeCount: 0,
      }).protocolAction,
    ).toBe("LENDING_INTERACTION");
    expect(
      classifyAlertIntelligence({
        venueLabel: "Jupiter Lend Borrow",
        priorTransferCount: 20,
        finalized: true,
        normalized: true,
        outcomeCount: 0,
      }).direction,
    ).toBe("PROTOCOL_INTERACTION");
  });

  it("keeps unverified transfers unclassified", () => {
    expect(
      classifyAlertIntelligence({
        priorTransferCount: 100,
        quantityZScore: 0.2,
        dormantDays: 0.01,
        finalized: true,
        normalized: true,
        outcomeCount: 0,
      }),
    ).toMatchObject({
      direction: "UNCLASSIFIED_TRANSFER",
      protocolAction: "NONE",
      walletAnomaly: "NORMAL",
    });
  });

  it("summarizes a transaction without combining quantities from different assets", () => {
    const classified = classifyAlertIntelligence({
      toEntityType: "EXCHANGE",
      priorTransferCount: 25,
      quantityZScore: 3.5,
      finalized: true,
      normalized: true,
      outcomeCount: 2,
    });
    expect(
      summarizeAlertIntelligence([
        {
          assetId: "SOL",
          intelligence: classified,
          outcomeCount: 2,
          marketReactionCount: 1,
          quantityZScore: 3.5,
        },
        {
          assetId: "USDC",
          intelligence: { ...classified, qualityScore: 40, walletAnomaly: "NORMAL" },
          outcomeCount: 0,
          marketReactionCount: 2,
        },
      ]),
    ).toEqual({
      transferCount: 2,
      assetCount: 2,
      maxQualityScore: classified.qualityScore,
      primaryDirection: "EXCHANGE_INFLOW",
      primaryProtocolAction: "NONE",
      anomalousTransferCount: 1,
      matureOutcomeCount: 2,
      marketReactionCount: 3,
      maxAbsoluteZScore: 3.5,
    });
  });
});
