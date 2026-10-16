import { contentHash } from "@autonomous-trading-lab/domain";
import { z } from "zod";

const SymbolSchema = z.string().regex(/^[A-Z0-9]{2,12}$/);
const OpenInterestRowSchema = z
  .object({
    exchange: z.string().min(1),
    symbol: z.string().min(1),
    open_interest_usd: z.number().nonnegative(),
    open_interest_quantity: z.number().nonnegative().optional(),
    open_interest_change_percent_5m: z.number().optional(),
    open_interest_change_percent_15m: z.number().optional(),
    open_interest_change_percent_1h: z.number().optional(),
    open_interest_change_percent_4h: z.number().optional(),
    open_interest_change_percent_24h: z.number().optional(),
  })
  .loose();
const ResponseSchema = z
  .object({
    code: z.union([z.string(), z.number()]),
    msg: z.string().optional(),
    data: z.array(OpenInterestRowSchema).optional(),
  })
  .loose();

export class CoinGlassAccessError extends Error {
  public constructor(
    readonly providerCode: string,
    readonly providerReason: string,
  ) {
    super(`CoinGlass capability unavailable (${providerCode}): ${providerReason}`);
    this.name = "CoinGlassAccessError";
  }
}

export interface CoinGlassClientOptions {
  readonly endpoint?: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
}

export class CoinGlassReadOnlyClient {
  readonly #endpoint: URL;
  readonly #timeoutMs: number;

  public constructor(
    private readonly options: CoinGlassClientOptions,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.#endpoint = new URL(options.endpoint ?? "https://open-api-v4.coinglass.com/api/");
    if (this.#endpoint.protocol !== "https:") throw new Error("CoinGlass endpoint must use HTTPS");
    if (this.#endpoint.hostname !== "open-api-v4.coinglass.com")
      throw new Error("CoinGlass endpoint host is not allowed");
    if (!options.apiKey.trim()) throw new Error("CoinGlass API key is required");
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1000 || this.#timeoutMs > 30_000)
      throw new Error("CoinGlass timeout must be between 1000 and 30000ms");
  }

  public async openInterestByExchange(symbol: string, observedAt = new Date().toISOString()) {
    const normalizedSymbol = SymbolSchema.parse(symbol.toUpperCase());
    if (!Number.isFinite(new Date(observedAt).getTime()))
      throw new Error("observedAt must be a valid timestamp");
    const url = new URL("futures/open-interest/exchange-list", this.#endpoint);
    url.searchParams.set("symbol", normalizedSymbol);
    const response = await this.fetcher(url, {
      headers: { accept: "application/json", "CG-API-KEY": this.options.apiKey },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) throw new Error(`CoinGlass request failed with ${String(response.status)}`);
    const payload = ResponseSchema.parse(await response.json());
    const providerCode = String(payload.code);
    if (providerCode !== "0" && providerCode !== "000000")
      throw new CoinGlassAccessError(providerCode, (payload.msg ?? "RESTRICTED").slice(0, 120));
    if (!payload.data) throw new Error("CoinGlass success response omitted data");
    return {
      provider: "coinglass" as const,
      endpoint: "futures/open-interest/exchange-list" as const,
      symbol: normalizedSymbol,
      observedAt,
      receivedAt: new Date().toISOString(),
      data: payload.data,
      responseHash: contentHash(payload),
      adapterVersion: 1 as const,
    };
  }
}
