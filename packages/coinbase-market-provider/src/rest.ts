import { z } from "zod";

export interface CoinbaseTradeBackfillSource {
  fetchTrades(
    productId: string,
    fromTradeId: number,
    toTradeId: number,
    limit: number,
  ): Promise<readonly unknown[]>;
}

const RestTradeSchema = z
  .object({
    trade_id: z.number().int().nonnegative(),
    time: z.iso.datetime({ offset: true }),
    size: z.string(),
    price: z.string(),
    side: z.enum(["buy", "sell"]),
  })
  .strict();

export interface CoinbasePublicRestOptions {
  readonly endpoint: string;
  readonly timeoutMs: number;
}

export type PublicRestFetch = (
  input: string,
  init: { readonly method: "GET"; readonly signal: AbortSignal },
) => Promise<Response>;

export class CoinbasePublicRestTradeSource implements CoinbaseTradeBackfillSource {
  readonly #endpoint: URL;
  readonly #timeoutMs: number;

  public constructor(
    candidate: CoinbasePublicRestOptions,
    private readonly request: PublicRestFetch = fetch,
  ) {
    const endpoint = new URL(candidate.endpoint);
    if (
      endpoint.protocol !== "https:" &&
      !(
        endpoint.protocol === "http:" &&
        (endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1")
      )
    )
      throw new Error("Coinbase REST endpoint must use HTTPS unless it is local");
    if (
      !Number.isInteger(candidate.timeoutMs) ||
      candidate.timeoutMs < 1000 ||
      candidate.timeoutMs > 30_000
    )
      throw new Error("Coinbase REST timeout must be between 1000 and 30000ms");
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/`;
    this.#endpoint = endpoint;
    this.#timeoutMs = candidate.timeoutMs;
  }

  public async fetchTrades(
    productId: string,
    fromTradeId: number,
    toTradeId: number,
    limit: number,
  ): Promise<readonly unknown[]> {
    if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(productId)) throw new Error("invalid Coinbase product ID");
    if (!Number.isSafeInteger(fromTradeId) || !Number.isSafeInteger(toTradeId))
      throw new Error("trade IDs must be safe integers");
    if (toTradeId < fromTradeId) throw new Error("backfill range is reversed");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("REST trade limit must be between 1 and 1000");
    const requestedCount = toTradeId - fromTradeId + 1;
    if (requestedCount > limit) throw new Error("REST trade range exceeds the bounded limit");
    const url = new URL(`products/${encodeURIComponent(productId)}/trades`, this.#endpoint);
    url.searchParams.set("limit", String(requestedCount));
    // Coinbase returns trades newest-first. `after` is the exclusive older-than cursor,
    // so toTradeId + 1 targets the exact historical gap instead of the latest page.
    url.searchParams.set("after", String(toTradeId + 1));
    const response = await this.request(url.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok)
      throw new Error(`Coinbase public trades request failed with ${String(response.status)}`);
    const payload = z.array(RestTradeSchema).parse(await response.json());
    return payload
      .filter((trade) => trade.trade_id >= fromTradeId && trade.trade_id <= toTradeId)
      .sort((left, right) => left.trade_id - right.trade_id)
      .map((trade) => ({
        type: "match",
        product_id: productId,
        sequence: trade.trade_id,
        ...trade,
      }));
  }
}
