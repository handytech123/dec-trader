import { describe, expect, it } from "vitest";
import {
  SequencedOrderBook,
  computeMarketReactionFeatures,
  classifyMarketResponseFailure,
  computeTradeImbalance,
  classifyAbsorptionCandidate,
  detectSweepV1,
} from "../src/index.js";

describe("sequenced order book", () => {
  it("sorts snapshots and applies contiguous deltas", () => {
    const book = new SequencedOrderBook();
    book.applySnapshot({
      sequence: "10",
      bids: [
        { price: "99", size: "2" },
        { price: "100", size: "1" },
      ],
      asks: [
        { price: "102", size: "2" },
        { price: "101", size: "1" },
      ],
    });
    book.applyDelta({
      sequence: "11",
      bids: [{ price: "99", size: "0" }],
      asks: [{ price: "103", size: "3" }],
    });
    expect(book.view()).toEqual({
      sequence: "11",
      bids: [{ price: "100", size: "1" }],
      asks: [
        { price: "101", size: "1" },
        { price: "102", size: "2" },
        { price: "103", size: "3" },
      ],
    });
  });

  it("detects missing sequence, invalid levels, and crossed books", () => {
    const book = new SequencedOrderBook();
    expect(() => {
      book.applyDelta({ sequence: "1", bids: [], asks: [] });
    }).toThrow(/snapshot/);
    book.applySnapshot({
      sequence: "1",
      bids: [{ price: "100", size: "1" }],
      asks: [{ price: "101", size: "1" }],
    });
    expect(() => {
      book.applyDelta({ sequence: "3", bids: [], asks: [] });
    }).toThrow(/gap/);
    expect(() => {
      book.applyDelta({ sequence: "2", bids: [{ price: "102", size: "1" }], asks: [] });
    }).toThrow(/crossed/);
  });
});

describe("market response failure", () => {
  it("labels response failures without inventing intent", () => {
    const features = {
      featureVersion: "1" as const,
      spreadBpsBefore: "2",
      spreadBpsAfter: "3",
      bidDepthBefore: "1000",
      askDepthBefore: "1000",
      bidDepthAfter: "700",
      askDepthAfter: "700",
      totalDepthChangePct: "-30",
      aggressiveBuyVolume: "10",
      aggressiveSellVolume: "90",
      aggressorImbalance: "-0.8",
      tradedVolume: "100",
      realizedVolatilityPct: "0.1",
      midPriceReturnPct: "-0.02",
      absorptionScore: "40",
      inputEventIds: ["trade-b", "trade-a"],
    };
    const result = classifyMarketResponseFailure({
      features,
      recoveryReturnPct: "0.2",
      recoverySeconds: 20,
      policy: {
        algorithmVersion: "1",
        minimumAbsoluteImbalance: "0.7",
        maximumAbsoluteDisplacementPct: "0.05",
        minimumTradedVolume: "50",
        minimumLiquidityWithdrawalPct: "20",
        maximumRecoverySeconds: 60,
      },
    });
    expect(result.labels).toEqual([
      "HEAVY_SELLING_LIMITED_DOWNSIDE",
      "HIGH_VOLUME_LOW_DISPLACEMENT",
      "LIQUIDITY_REMOVAL_RAPID_RECOVERY",
    ]);
    expect(result.evidenceEventIds).toEqual(["trade-a", "trade-b"]);
  });
});

describe("order-flow features", () => {
  it("calculates deterministic aggressive trade imbalance with input evidence", () => {
    expect(
      computeTradeImbalance([
        { eventId: "b", side: "BUY", quantity: "30" },
        { eventId: "a", side: "SELL", quantity: "10" },
      ]),
    ).toEqual({
      aggressiveBuyVolume: "30",
      aggressiveSellVolume: "10",
      imbalance: "0.5",
      inputEventIds: ["a", "b"],
      algorithmVersion: "1",
    });
    expect(computeTradeImbalance([]).imbalance).toBeNull();
    expect(() => computeTradeImbalance([{ eventId: "x", side: "BUY", quantity: "-1" }])).toThrow(
      /non-negative/,
    );
  });

  it("computes spread, depth, aggression, volatility, and absorption from bounded evidence", () => {
    const features = computeMarketReactionFeatures({
      before: {
        sequence: "10",
        bids: [
          { price: "99", size: "2" },
          { price: "98", size: "1" },
        ],
        asks: [
          { price: "101", size: "2" },
          { price: "102", size: "1" },
        ],
      },
      after: {
        sequence: "20",
        bids: [
          { price: "100", size: "1" },
          { price: "99", size: "1" },
        ],
        asks: [
          { price: "102", size: "1" },
          { price: "103", size: "1" },
        ],
      },
      trades: [
        {
          eventId: "trade-b",
          eventTime: "2026-01-01T00:00:02.000Z",
          side: "BUY",
          price: "101",
          quantity: "3",
        },
        {
          eventId: "trade-a",
          eventTime: "2026-01-01T00:00:01.000Z",
          side: "SELL",
          price: "100",
          quantity: "1",
        },
      ],
      depthLevels: 2,
    });
    expect(features.featureVersion).toBe("1");
    expect(features.spreadBpsBefore).toBe("200");
    expect(features.spreadBpsAfter).toBe("198.0198019801980198");
    expect(features.bidDepthBefore).toBe("296");
    expect(features.askDepthBefore).toBe("304");
    expect(features.totalDepthChangePct).toBe("-32.666666666666666667");
    expect(features.aggressorImbalance).toBe("0.5");
    expect(features.tradedVolume).toBe("4");
    expect(Number(features.realizedVolatilityPct)).toBeGreaterThan(0);
    expect(features.midPriceReturnPct).toBe("1");
    expect(features.absorptionScore).toBe("0.02");
    expect(features.inputEventIds).toEqual(["trade-a", "trade-b"]);
  });

  it("fails closed on invalid books and bounded-depth policy", () => {
    const book = {
      sequence: "1",
      bids: [{ price: "100", size: "1" }],
      asks: [{ price: "99", size: "1" }],
    };
    expect(() => computeMarketReactionFeatures({ before: book, after: book, trades: [] })).toThrow(
      /crossed/,
    );
    expect(() =>
      computeMarketReactionFeatures({
        before: { ...book, asks: [{ price: "101", size: "1" }] },
        after: { ...book, asks: [{ price: "101", size: "1" }] },
        trades: [],
        depthLevels: 0,
      }),
    ).toThrow(/depth levels/);
  });

  it("labels quantitative absorption candidates without inferring counterparties", () => {
    expect(
      classifyAbsorptionCandidate({
        aggressiveBuyQuantity: "10",
        aggressiveSellQuantity: "1000",
        midPriceReturnBps: "-2",
        inputEvidenceIds: ["trade-b", "trade-a"],
        policy: {
          algorithmVersion: "1",
          minimumAggressiveQuantity: "500",
          maximumAbsoluteMoveBps: "5",
        },
      }),
    ).toMatchObject({
      candidate: "SELL_ABSORPTION_CANDIDATE",
      inputEvidenceIds: ["trade-a", "trade-b"],
    });
  });

  it("detects evidence-linked sweeps and fails closed across sequence gaps", () => {
    const trades = [
      {
        eventId: "a",
        sequence: "10",
        eventTime: "2026-01-01T00:00:00.000Z",
        side: "BUY" as const,
        price: "100",
        quantity: "2",
      },
      {
        eventId: "b",
        sequence: "11",
        eventTime: "2026-01-01T00:00:01.000Z",
        side: "BUY" as const,
        price: "101",
        quantity: "3",
      },
      {
        eventId: "c",
        sequence: "12",
        eventTime: "2026-01-01T00:00:02.000Z",
        side: "BUY" as const,
        price: "102",
        quantity: "4",
      },
    ];
    expect(
      detectSweepV1({
        trades,
        sequenceContiguous: true,
        minimumLevels: 2,
        minimumDisplacementBps: "50",
        recoveryPrice: "101",
      }),
    ).toMatchObject({
      status: "COMPLETE",
      sweeps: [{ levelsTraversed: 3, executedQuantity: "9", inputEvidenceIds: ["a", "b", "c"] }],
    });
    expect(
      detectSweepV1({
        trades,
        sequenceContiguous: false,
        minimumLevels: 2,
        minimumDisplacementBps: "50",
      }),
    ).toEqual({ algorithmVersion: "1", status: "INVALID_SEQUENCE", sweeps: [] });
  });
});
