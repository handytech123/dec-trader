import { Decimal } from "decimal.js";
import { z } from "zod";

const FeedIdSchema = z.string().regex(/^(?:0x)?[0-9a-fA-F]{64}$/);
const PriceSchema = z
  .object({
    price: z.string().regex(/^-?\d+$/),
    conf: z.string().regex(/^\d+$/),
    expo: z.number().int().min(-30).max(30),
    publish_time: z.number().int().nonnegative(),
  })
  .strict();
const ResponseSchema = z
  .object({
    parsed: z.array(
      z
        .object({
          id: z.string(),
          price: PriceSchema,
        })
        .loose(),
    ),
  })
  .loose();

export interface PythPriceObservation {
  readonly feedId: string;
  readonly price: string;
  readonly confidence: string;
  readonly publishedAt: string;
  readonly observedAt: string;
  readonly source: "pyth-hermes-v2";
}

export interface PythHermesOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
}

export class PythHermesPriceSource {
  readonly #endpoint: URL;

  public constructor(
    private readonly options: PythHermesOptions,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.#endpoint = new URL(options.endpoint);
    if (
      this.#endpoint.protocol !== "https:" &&
      this.#endpoint.hostname !== "localhost" &&
      this.#endpoint.hostname !== "127.0.0.1"
    )
      throw new Error("Pyth endpoint must use HTTPS unless it is local");
    if (!options.apiKey.trim()) throw new Error("Pyth API key is required");
    if (
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 1000 ||
      options.timeoutMs > 30_000
    )
      throw new Error("Pyth timeout must be between 1000 and 30000ms");
  }

  public async latest(
    feedIds: readonly string[],
    observedAt = new Date().toISOString(),
  ): Promise<readonly PythPriceObservation[]> {
    if (feedIds.length < 1 || feedIds.length > 20)
      throw new Error("between 1 and 20 Pyth feed IDs are required");
    const normalized = [
      ...new Set(
        feedIds.map((feedId) => FeedIdSchema.parse(feedId).replace(/^0x/, "").toLowerCase()),
      ),
    ];
    const url = new URL("v2/updates/price/latest", this.#endpoint.toString().replace(/\/?$/, "/"));
    for (const feedId of normalized) url.searchParams.append("ids[]", `0x${feedId}`);
    const response = await this.fetcher(url, {
      headers: { authorization: `Bearer ${this.options.apiKey}` },
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) throw new Error(`Pyth price request failed with ${String(response.status)}`);
    const parsed = ResponseSchema.parse(await response.json()).parsed;
    const byId = new Map(parsed.map((entry) => [entry.id.replace(/^0x/, "").toLowerCase(), entry]));
    return normalized.map((feedId) => {
      const entry = byId.get(feedId);
      if (!entry) throw new Error(`Pyth response omitted feed ${feedId}`);
      const multiplier = new Decimal(10).pow(entry.price.expo);
      return {
        feedId,
        price: new Decimal(entry.price.price).mul(multiplier).toString(),
        confidence: new Decimal(entry.price.conf).mul(multiplier).toString(),
        publishedAt: new Date(entry.price.publish_time * 1000).toISOString(),
        observedAt,
        source: "pyth-hermes-v2",
      };
    });
  }
}
