import { Decimal } from "decimal.js";

export interface PriceLevel {
  readonly price: string;
  readonly size: string;
}

export interface OrderBookSnapshot {
  readonly sequence: string;
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
}

export interface OrderBookDelta {
  readonly sequence: string;
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
}

const sequence = (value: string): bigint => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("sequence must be an unsigned integer");
  return BigInt(value);
};

const validateLevel = (level: PriceLevel): void => {
  const price = new Decimal(level.price);
  const size = new Decimal(level.size);
  if (!price.isPositive()) throw new Error("order-book price must be positive");
  if (size.isNegative()) throw new Error("order-book size must be non-negative");
};

export class SequencedOrderBook {
  readonly #bids = new Map<string, string>();
  readonly #asks = new Map<string, string>();
  #sequence: bigint | undefined;

  public applySnapshot(snapshot: OrderBookSnapshot): void {
    const nextSequence = sequence(snapshot.sequence);
    this.#bids.clear();
    this.#asks.clear();
    this.#apply(this.#bids, snapshot.bids);
    this.#apply(this.#asks, snapshot.asks);
    this.#sequence = nextSequence;
    this.#assertNotCrossed();
  }

  public applyDelta(delta: OrderBookDelta): void {
    if (this.#sequence === undefined) throw new Error("order-book snapshot is required");
    const nextSequence = sequence(delta.sequence);
    if (nextSequence !== this.#sequence + 1n)
      throw new Error(
        `order-book sequence gap: expected ${String(this.#sequence + 1n)}, received ${delta.sequence}`,
      );
    this.#apply(this.#bids, delta.bids);
    this.#apply(this.#asks, delta.asks);
    this.#assertNotCrossed();
    this.#sequence = nextSequence;
  }

  public view(): OrderBookSnapshot {
    if (this.#sequence === undefined) throw new Error("order-book snapshot is required");
    const levels = (entries: IterableIterator<[string, string]>, descending: boolean) =>
      [...entries]
        .map(([price, size]) => ({ price, size }))
        .sort((left, right) => {
          const comparison = new Decimal(left.price).comparedTo(right.price);
          return descending ? -comparison : comparison;
        });
    return {
      sequence: this.#sequence.toString(),
      bids: levels(this.#bids.entries(), true),
      asks: levels(this.#asks.entries(), false),
    };
  }

  #apply(side: Map<string, string>, levels: readonly PriceLevel[]): void {
    for (const level of levels) {
      validateLevel(level);
      if (new Decimal(level.size).isZero()) side.delete(level.price);
      else side.set(level.price, level.size);
    }
  }

  #assertNotCrossed(): void {
    if (this.#bids.size === 0 || this.#asks.size === 0) return;
    const bestBid = Decimal.max(...[...this.#bids.keys()].map((price) => new Decimal(price)));
    const bestAsk = Decimal.min(...[...this.#asks.keys()].map((price) => new Decimal(price)));
    if (bestBid.greaterThanOrEqualTo(bestAsk)) throw new Error("order book is crossed or locked");
  }
}

export interface AggressiveTrade {
  readonly side: "BUY" | "SELL";
  readonly quantity: string;
  readonly eventId: string;
}

export function computeTradeImbalance(trades: readonly AggressiveTrade[]): {
  readonly aggressiveBuyVolume: string;
  readonly aggressiveSellVolume: string;
  readonly imbalance: string | null;
  readonly inputEventIds: readonly string[];
  readonly algorithmVersion: "1";
} {
  let buys = new Decimal(0);
  let sells = new Decimal(0);
  for (const trade of trades) {
    const quantity = new Decimal(trade.quantity);
    if (quantity.isNegative()) throw new Error("trade quantity must be non-negative");
    if (trade.side === "BUY") buys = buys.plus(quantity);
    else sells = sells.plus(quantity);
  }
  const total = buys.plus(sells);
  return {
    aggressiveBuyVolume: buys.toString(),
    aggressiveSellVolume: sells.toString(),
    imbalance: total.isZero() ? null : buys.minus(sells).div(total).toString(),
    inputEventIds: trades.map((trade) => trade.eventId).sort(),
    algorithmVersion: "1",
  };
}

export interface TimedTrade extends AggressiveTrade {
  readonly eventTime: string;
  readonly price: string;
}

export interface MarketReactionFeatures {
  readonly featureVersion: "1";
  readonly spreadBpsBefore: string | null;
  readonly spreadBpsAfter: string | null;
  readonly bidDepthBefore: string;
  readonly askDepthBefore: string;
  readonly bidDepthAfter: string;
  readonly askDepthAfter: string;
  readonly totalDepthChangePct: string | null;
  readonly aggressiveBuyVolume: string;
  readonly aggressiveSellVolume: string;
  readonly aggressorImbalance: string | null;
  readonly tradedVolume: string;
  readonly realizedVolatilityPct: string | null;
  readonly midPriceReturnPct: string | null;
  readonly absorptionScore: string | null;
  readonly inputEventIds: readonly string[];
}

const positive = (value: string, name: string): Decimal => {
  const parsed = new Decimal(value);
  if (!parsed.isPositive()) throw new Error(`${name} must be positive`);
  return parsed;
};

function bookMetrics(
  book: OrderBookSnapshot,
  depthLevels: number,
): {
  readonly spreadBps: Decimal | null;
  readonly bidDepth: Decimal;
  readonly askDepth: Decimal;
  readonly mid: Decimal | null;
} {
  if (!Number.isInteger(depthLevels) || depthLevels < 1 || depthLevels > 1000)
    throw new Error("depth levels must be an integer between 1 and 1000");
  const bids = book.bids.slice(0, depthLevels);
  const asks = book.asks.slice(0, depthLevels);
  const notional = (level: PriceLevel): Decimal => {
    const size = new Decimal(level.size);
    if (size.isNegative()) throw new Error("book size must be non-negative");
    return positive(level.price, "book price").times(size);
  };
  const bidDepth = Decimal.sum(0, ...bids.map(notional));
  const askDepth = Decimal.sum(0, ...asks.map(notional));
  const bestBid = bids[0] ? positive(bids[0].price, "best bid") : null;
  const bestAsk = asks[0] ? positive(asks[0].price, "best ask") : null;
  if (bestBid === null || bestAsk === null)
    return { spreadBps: null, bidDepth, askDepth, mid: null };
  if (bestBid.greaterThanOrEqualTo(bestAsk)) throw new Error("order book is crossed or locked");
  const mid = bestBid.plus(bestAsk).div(2);
  return {
    spreadBps: bestAsk.minus(bestBid).div(mid).times(10_000),
    bidDepth,
    askDepth,
    mid,
  };
}

export function computeMarketReactionFeatures(input: {
  readonly before: OrderBookSnapshot;
  readonly after: OrderBookSnapshot;
  readonly trades: readonly TimedTrade[];
  readonly depthLevels?: number;
}): MarketReactionFeatures {
  const before = bookMetrics(input.before, input.depthLevels ?? 10);
  const after = bookMetrics(input.after, input.depthLevels ?? 10);
  const imbalance = computeTradeImbalance(input.trades);
  const totalBefore = before.bidDepth.plus(before.askDepth);
  const totalAfter = after.bidDepth.plus(after.askDepth);
  const totalDepthChangePct = totalBefore.isZero()
    ? null
    : totalAfter.minus(totalBefore).div(totalBefore).times(100);
  const sortedTrades = [...input.trades].sort(
    (left, right) =>
      left.eventTime.localeCompare(right.eventTime) || left.eventId.localeCompare(right.eventId),
  );
  const prices = sortedTrades.map((trade) => positive(trade.price, "trade price"));
  const quantities = sortedTrades.map((trade) => {
    const value = new Decimal(trade.quantity);
    if (value.isNegative()) throw new Error("trade quantity must be non-negative");
    return value;
  });
  const tradedVolume = Decimal.sum(0, ...quantities);
  const logReturns = prices.slice(1).map((price, index) => {
    // The sliced item at index + 1 guarantees a prior item at index.
    // eslint-disable-next-line security/detect-object-injection
    const previous = prices[index];
    if (!previous) throw new Error("prior price unexpectedly missing");
    return Math.log(price.div(previous).toNumber());
  });
  const realizedVolatilityPct =
    logReturns.length === 0
      ? null
      : new Decimal(Math.sqrt(logReturns.reduce((sum, value) => sum + value ** 2, 0))).times(100);
  const midPriceReturnPct =
    before.mid === null || after.mid === null
      ? null
      : after.mid.minus(before.mid).div(before.mid).times(100);
  const signedVolume = new Decimal(imbalance.aggressiveBuyVolume).minus(
    imbalance.aggressiveSellVolume,
  );
  // Higher absolute values mean more signed aggression was absorbed per basis point of movement.
  const absorptionScore =
    midPriceReturnPct === null || midPriceReturnPct.isZero()
      ? null
      : signedVolume.div(midPriceReturnPct.abs().times(100));
  return {
    featureVersion: "1",
    spreadBpsBefore: before.spreadBps?.toString() ?? null,
    spreadBpsAfter: after.spreadBps?.toString() ?? null,
    bidDepthBefore: before.bidDepth.toString(),
    askDepthBefore: before.askDepth.toString(),
    bidDepthAfter: after.bidDepth.toString(),
    askDepthAfter: after.askDepth.toString(),
    totalDepthChangePct: totalDepthChangePct?.toString() ?? null,
    aggressiveBuyVolume: imbalance.aggressiveBuyVolume,
    aggressiveSellVolume: imbalance.aggressiveSellVolume,
    aggressorImbalance: imbalance.imbalance,
    tradedVolume: tradedVolume.toString(),
    realizedVolatilityPct: realizedVolatilityPct?.toString() ?? null,
    midPriceReturnPct: midPriceReturnPct?.toString() ?? null,
    absorptionScore: absorptionScore?.toString() ?? null,
    inputEventIds: sortedTrades.map((trade) => trade.eventId),
  };
}

export interface AbsorptionPolicyV1 {
  readonly algorithmVersion: "1";
  readonly minimumAggressiveQuantity: string;
  readonly maximumAbsoluteMoveBps: string;
}

export function classifyAbsorptionCandidate(input: {
  readonly aggressiveBuyQuantity: string;
  readonly aggressiveSellQuantity: string;
  readonly midPriceReturnBps: string;
  readonly inputEvidenceIds: readonly string[];
  readonly policy: AbsorptionPolicyV1;
}) {
  const buys = new Decimal(input.aggressiveBuyQuantity);
  const sells = new Decimal(input.aggressiveSellQuantity);
  const move = new Decimal(input.midPriceReturnBps);
  const minimum = positive(input.policy.minimumAggressiveQuantity, "minimum aggression");
  const maximumMove = positive(input.policy.maximumAbsoluteMoveBps, "maximum move");
  if (buys.isNegative() || sells.isNegative()) throw new Error("aggression must be non-negative");
  const candidate =
    sells.greaterThanOrEqualTo(minimum) && move.abs().lessThanOrEqualTo(maximumMove)
      ? "SELL_ABSORPTION_CANDIDATE"
      : buys.greaterThanOrEqualTo(minimum) && move.abs().lessThanOrEqualTo(maximumMove)
        ? "BUY_ABSORPTION_CANDIDATE"
        : "NONE";
  return {
    algorithmVersion: input.policy.algorithmVersion,
    candidate,
    aggressiveBuyQuantity: buys.toString(),
    aggressiveSellQuantity: sells.toString(),
    midPriceReturnBps: move.toString(),
    inputEvidenceIds: [...input.inputEvidenceIds].sort(),
  } as const;
}

export interface MarketResponseFailurePolicyV1 {
  readonly algorithmVersion: "1";
  readonly minimumAbsoluteImbalance: string;
  readonly maximumAbsoluteDisplacementPct: string;
  readonly minimumTradedVolume: string;
  readonly minimumLiquidityWithdrawalPct: string;
  readonly maximumRecoverySeconds: number;
}

export function classifyMarketResponseFailure(input: {
  readonly features: MarketReactionFeatures;
  readonly recoveryReturnPct?: string;
  readonly recoverySeconds?: number;
  readonly policy: MarketResponseFailurePolicyV1;
}) {
  const imbalance =
    input.features.aggressorImbalance === null
      ? null
      : new Decimal(input.features.aggressorImbalance);
  const displacement =
    input.features.midPriceReturnPct === null
      ? null
      : new Decimal(input.features.midPriceReturnPct);
  const tradedVolume = new Decimal(input.features.tradedVolume);
  const depthChange =
    input.features.totalDepthChangePct === null
      ? null
      : new Decimal(input.features.totalDepthChangePct);
  const minimumImbalance = positive(input.policy.minimumAbsoluteImbalance, "minimum imbalance");
  const maximumDisplacement = positive(
    input.policy.maximumAbsoluteDisplacementPct,
    "maximum displacement",
  );
  const minimumVolume = positive(input.policy.minimumTradedVolume, "minimum traded volume");
  const minimumWithdrawal = positive(
    input.policy.minimumLiquidityWithdrawalPct,
    "minimum liquidity withdrawal",
  );
  if (
    !Number.isInteger(input.policy.maximumRecoverySeconds) ||
    input.policy.maximumRecoverySeconds < 1
  )
    throw new Error("maximum recovery seconds must be a positive integer");
  const labels: string[] = [];
  if (
    imbalance &&
    displacement &&
    imbalance.lessThanOrEqualTo(minimumImbalance.negated()) &&
    displacement.abs().lessThanOrEqualTo(maximumDisplacement)
  )
    labels.push("HEAVY_SELLING_LIMITED_DOWNSIDE");
  if (
    imbalance &&
    displacement &&
    imbalance.greaterThanOrEqualTo(minimumImbalance) &&
    displacement.abs().lessThanOrEqualTo(maximumDisplacement)
  )
    labels.push("HEAVY_BUYING_LIMITED_UPSIDE");
  if (
    displacement &&
    tradedVolume.greaterThanOrEqualTo(minimumVolume) &&
    displacement.abs().lessThanOrEqualTo(maximumDisplacement)
  )
    labels.push("HIGH_VOLUME_LOW_DISPLACEMENT");
  if (
    depthChange?.lessThanOrEqualTo(minimumWithdrawal.negated()) &&
    input.recoveryReturnPct !== undefined &&
    input.recoverySeconds !== undefined &&
    input.recoverySeconds <= input.policy.maximumRecoverySeconds &&
    new Decimal(input.recoveryReturnPct).isPositive()
  )
    labels.push("LIQUIDITY_REMOVAL_RAPID_RECOVERY");
  return {
    algorithmVersion: input.policy.algorithmVersion,
    labels: labels.length === 0 ? ["NONE"] : labels,
    inputs: {
      aggressorImbalance: input.features.aggressorImbalance,
      displacementPct: input.features.midPriceReturnPct,
      tradedVolume: input.features.tradedVolume,
      totalDepthChangePct: input.features.totalDepthChangePct,
      recoveryReturnPct: input.recoveryReturnPct ?? null,
      recoverySeconds: input.recoverySeconds ?? null,
    },
    evidenceEventIds: [...input.features.inputEventIds].sort(),
  } as const;
}

export interface SweepTrade {
  readonly eventId: string;
  readonly sequence: string;
  readonly eventTime: string;
  readonly side: "BUY" | "SELL";
  readonly price: string;
  readonly quantity: string;
}

export function detectSweepV1(input: {
  readonly trades: readonly SweepTrade[];
  readonly sequenceContiguous: boolean;
  readonly minimumLevels: number;
  readonly minimumDisplacementBps: string;
  readonly recoveryPrice?: string;
  readonly recoveryAt?: string;
}) {
  if (!input.sequenceContiguous)
    return { algorithmVersion: "1" as const, status: "INVALID_SEQUENCE" as const, sweeps: [] };
  if (!Number.isInteger(input.minimumLevels) || input.minimumLevels < 2)
    throw new Error("minimum sweep levels must be at least two");
  const minimumDisplacement = positive(input.minimumDisplacementBps, "minimum displacement");
  const ordered = [...input.trades].sort((left, right) =>
    BigInt(left.sequence) < BigInt(right.sequence)
      ? -1
      : BigInt(left.sequence) > BigInt(right.sequence)
        ? 1
        : left.eventId.localeCompare(right.eventId),
  );
  const groups: SweepTrade[][] = [];
  for (const trade of ordered) {
    positive(trade.price, "trade price");
    positive(trade.quantity, "trade quantity");
    const current = groups.at(-1);
    if (current?.at(-1)?.side === trade.side) current.push(trade);
    else groups.push([trade]);
  }
  const sweeps = groups.flatMap((trades) => {
    const first = trades.at(0);
    const last = trades.at(-1);
    if (!first || !last) return [];
    const levels = new Set(trades.map((trade) => trade.price)).size;
    const firstPrice = new Decimal(first.price);
    const lastPrice = new Decimal(last.price);
    const displacementBps = lastPrice.minus(firstPrice).abs().div(firstPrice).times(10_000);
    if (levels < input.minimumLevels || displacementBps.lessThan(minimumDisplacement)) return [];
    const executedQuantity = Decimal.sum(...trades.map((trade) => new Decimal(trade.quantity)));
    const recoveryBps = input.recoveryPrice
      ? new Decimal(input.recoveryPrice).minus(lastPrice).div(lastPrice).times(10_000)
      : null;
    return [
      {
        side: first.side,
        startedAt: first.eventTime,
        endedAt: last.eventTime,
        sequenceStart: first.sequence,
        sequenceEnd: last.sequence,
        levelsTraversed: levels,
        executedQuantity: executedQuantity.toString(),
        displacementBps: displacementBps.toString(),
        recoveryBps: recoveryBps?.toString() ?? null,
        recoveryAt: input.recoveryAt ?? null,
        inputEvidenceIds: trades.map((trade) => trade.eventId).sort(),
      },
    ];
  });
  return { algorithmVersion: "1" as const, status: "COMPLETE" as const, sweeps };
}
