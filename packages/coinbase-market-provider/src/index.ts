import { z } from "zod";
import { MarketEventSchema, type MarketEvent } from "@autonomous-trading-lab/capital-flow";
import { contentHash, deterministicDomainId } from "@autonomous-trading-lab/domain";
import { SequencedOrderBook, type OrderBookSnapshot } from "@autonomous-trading-lab/order-flow";
import type { CoinbaseTradeBackfillSource } from "./rest.js";

export * from "./lifecycle.js";
export * from "./rest.js";
export * from "./websocket.js";

const MatchSchema = z
  .object({
    type: z.enum(["match", "last_match"]),
    trade_id: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative(),
    time: z.iso.datetime({ offset: true }),
    product_id: z.string().min(1),
    size: z.string(),
    price: z.string(),
    side: z.enum(["buy", "sell"]),
  })
  .loose();
const SnapshotSchema = z
  .object({
    type: z.literal("snapshot"),
    product_id: z.string().min(1),
    bids: z.array(z.tuple([z.string(), z.string()])),
    asks: z.array(z.tuple([z.string(), z.string()])),
  })
  .loose();
const UpdateSchema = z
  .object({
    type: z.literal("l2update"),
    product_id: z.string().min(1),
    time: z.iso.datetime({ offset: true }),
    changes: z.array(z.tuple([z.enum(["buy", "sell"]), z.string(), z.string()])),
  })
  .loose();

export class CoinbaseTradeSequenceError extends Error {
  public constructor(
    public readonly productId: string,
    public readonly expectedTradeId: number,
    public readonly receivedTradeId: number,
    public readonly kind: "GAP" | "STALE_OR_DUPLICATE",
  ) {
    super(
      `trade ID ${kind === "GAP" ? "gap" : "stale or duplicate"}: expected ${String(expectedTradeId)}, received ${String(receivedTradeId)}`,
    );
    this.name = "CoinbaseTradeSequenceError";
  }
}

export async function fetchCoinbaseTradeGap(
  source: CoinbaseTradeBackfillSource,
  productId: string,
  fromTradeId: number,
  toTradeId: number,
  maximumTrades: number,
): Promise<readonly unknown[]> {
  if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(productId)) throw new Error("invalid Coinbase product ID");
  if (!Number.isSafeInteger(fromTradeId) || !Number.isSafeInteger(toTradeId))
    throw new Error("trade IDs must be safe integers");
  if (toTradeId < fromTradeId) throw new Error("backfill range is reversed");
  const count = toTradeId - fromTradeId + 1;
  if (!Number.isInteger(maximumTrades) || maximumTrades < 1 || maximumTrades > 1000)
    throw new Error("maximumTrades must be between 1 and 1000");
  if (count > maximumTrades) throw new Error("trade gap exceeds the bounded backfill limit");
  const trades = await source.fetchTrades(productId, fromTradeId, toTradeId, maximumTrades);
  if (trades.length !== count) throw new Error("backfill did not return the complete trade range");
  return trades.map((candidate, index) => {
    const trade = MatchSchema.parse(candidate);
    if (trade.product_id !== productId || trade.trade_id !== fromTradeId + index)
      throw new Error("backfill trades are not contiguous and ascending");
    return trade;
  });
}

export function normalizeCoinbaseMatch(message: unknown, ingestedAt: string): MarketEvent {
  const match = MatchSchema.parse(message);
  const identity = `coinbase:${match.product_id}:trade:${String(match.trade_id)}`;
  return MarketEventSchema.parse({
    eventId: deterministicDomainId("event", identity),
    eventTime: match.time,
    ingestTime: ingestedAt,
    source: "coinbase-exchange-matches",
    venue: "coinbase-exchange",
    instrumentId: deterministicDomainId("instrument", `coinbase:${match.product_id}`),
    eventType: "TRADE",
    price: match.price,
    quantity: match.size,
    // Coinbase documents side as the maker side, so the aggressor is the opposite side.
    side: match.side === "sell" ? "BUY" : "SELL",
    bookSequence: String(match.sequence),
    rawRef: contentHash(message),
    schemaVersion: "1",
  });
}

export class CoinbaseMarketSession {
  readonly #book = new SequencedOrderBook();
  #productId: string | undefined;
  #localBookSequence = 0;
  #lastTradeId: number | undefined;

  public constructor(lastTradeId?: number) {
    if (lastTradeId !== undefined && (!Number.isSafeInteger(lastTradeId) || lastTradeId < 0))
      throw new Error("lastTradeId must be a non-negative safe integer");
    this.#lastTradeId = lastTradeId;
  }

  public reconnect(): void {
    this.#productId = undefined;
    this.#localBookSequence = 0;
  }

  public resynchronizeTradeId(tradeId: number): void {
    if (!Number.isSafeInteger(tradeId) || tradeId < 0)
      throw new Error("tradeId must be a non-negative safe integer");
    this.#lastTradeId = tradeId;
  }

  public acceptBookMessage(message: unknown): OrderBookSnapshot {
    const snapshot = SnapshotSchema.safeParse(message);
    if (snapshot.success) {
      this.#productId = snapshot.data.product_id;
      this.#localBookSequence = 1;
      this.#book.applySnapshot({
        sequence: "1",
        bids: snapshot.data.bids.map(([price, size]) => ({ price, size })),
        asks: snapshot.data.asks.map(([price, size]) => ({ price, size })),
      });
      return this.#book.view();
    }
    const update = UpdateSchema.parse(message);
    if (this.#productId === undefined)
      throw new Error("snapshot required after connect or reconnect");
    if (update.product_id !== this.#productId)
      throw new Error("order-book product changed in session");
    this.#localBookSequence += 1;
    this.#book.applyDelta({
      sequence: String(this.#localBookSequence),
      bids: update.changes
        .filter(([side]) => side === "buy")
        .map(([, price, size]) => ({ price, size })),
      asks: update.changes
        .filter(([side]) => side === "sell")
        .map(([, price, size]) => ({ price, size })),
    });
    return this.#book.view();
  }

  public acceptMatch(message: unknown, ingestedAt: string): MarketEvent {
    const match = MatchSchema.parse(message);
    if (this.#lastTradeId !== undefined && match.trade_id !== this.#lastTradeId + 1) {
      const expected = this.#lastTradeId + 1;
      throw new CoinbaseTradeSequenceError(
        match.product_id,
        expected,
        match.trade_id,
        match.trade_id > expected ? "GAP" : "STALE_OR_DUPLICATE",
      );
    }
    this.#lastTradeId = match.trade_id;
    return normalizeCoinbaseMatch(match, ingestedAt);
  }
}
