import { contentHash } from "@autonomous-trading-lab/domain";
import { z } from "zod";

const ChainSchema = z.enum(["solana"]);
const PaginationSchema = z
  .object({ page: z.number().int().min(1).max(1000), per_page: z.number().int().min(1).max(100) })
  .strict();
const HoldingSchema = z
  .object({
    chain: z.string().min(1),
    token_address: z.string().min(1),
    token_symbol: z.string().min(1),
    token_sectors: z.array(z.string()),
    value_usd: z.number().nonnegative(),
    balance_24h_percent_change: z.number(),
    holders_count: z.number().int().nonnegative(),
    share_of_holdings_percent: z.number().nonnegative(),
    token_age_days: z.number().int().nonnegative(),
    market_cap_usd: z.number().nonnegative(),
  })
  .strict();
const ResponseSchema = z
  .object({
    data: z.array(HoldingSchema).max(100),
    pagination: z
      .object({
        page: z.number().int().positive(),
        per_page: z.number().int().positive().max(100),
        is_last_page: z.boolean(),
      })
      .loose(),
  })
  .strict();
const AddressLabelResponseSchema = z
  .object({
    data: z
      .array(z.object({ label: z.string().min(1), category: z.string().min(1) }).loose())
      .max(100),
    pagination: z
      .object({
        page: z.number().int().positive(),
        per_page: z.number().int().positive().max(100),
        is_last_page: z.boolean(),
      })
      .loose(),
  })
  .loose();

export type NansenSmartMoneyHolding = z.infer<typeof HoldingSchema>;
export type NansenSmartMoneyHoldingsResponse = z.infer<typeof ResponseSchema>;

export const NANSEN_SMART_MONEY_HOLDINGS_CREDITS = 5;
export const NANSEN_COMMON_LABEL_CREDITS = 100;
export const NANSEN_PREMIUM_LABEL_CREDITS = 500;

export class NansenAccessError extends Error {
  public constructor(
    readonly status: number,
    readonly providerReason: string,
  ) {
    super(`Nansen request failed with ${String(status)}: ${providerReason}`);
    this.name = "NansenAccessError";
  }
}

export function nansenSmartMoneyHoldingsRequest(input: {
  readonly chain: "solana";
  readonly page?: number;
  readonly perPage?: number;
}) {
  return {
    chains: [ChainSchema.parse(input.chain)],
    pagination: PaginationSchema.parse({ page: input.page ?? 1, per_page: input.perPage ?? 25 }),
    order_by: [{ field: "value_usd", direction: "DESC" }] as const,
  };
}

export function parseNansenSmartMoneyHoldingsResponse(value: unknown) {
  return ResponseSchema.parse(value);
}

export function nansenAddressLabelsRequest(input: {
  readonly address: string;
  readonly page?: number;
  readonly perPage?: number;
}) {
  return {
    address: z
      .string()
      .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "invalid Solana address")
      .parse(input.address),
    chain: "solana" as const,
    pagination: PaginationSchema.parse({ page: input.page ?? 1, per_page: input.perPage ?? 100 }),
  };
}

export function parseNansenAddressLabelsResponse(value: unknown) {
  return AddressLabelResponseSchema.parse(value);
}

export function nansenHoldingMetrics(holding: NansenSmartMoneyHolding) {
  const parsed = HoldingSchema.parse(holding);
  return [
    { metric: "smart_money_holdings_value_usd", value: parsed.value_usd, unit: "USD" },
    {
      metric: "smart_money_balance_24h_percent_change",
      value: parsed.balance_24h_percent_change,
      unit: "PERCENT",
    },
    { metric: "smart_money_holders_count", value: parsed.holders_count, unit: "COUNT" },
    {
      metric: "smart_money_share_of_holdings_percent",
      value: parsed.share_of_holdings_percent,
      unit: "PERCENT",
    },
    { metric: "token_market_cap_usd", value: parsed.market_cap_usd, unit: "USD" },
  ] as const;
}

export interface NansenClientOptions {
  readonly endpoint?: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
}

export interface NansenEvidenceEnvelope {
  readonly provider: "nansen";
  readonly endpoint: "smart-money/holdings";
  readonly requestedAt: string;
  readonly receivedAt: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly response: z.infer<typeof ResponseSchema>;
  readonly responseHash: `sha256:${string}`;
  readonly adapterVersion: 1;
}

export interface NansenAddressLabelsEnvelope {
  readonly provider: "nansen";
  readonly endpoint: "profiler/address/labels" | "profiler/address/premium-labels";
  readonly requestedAt: string;
  readonly receivedAt: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly response: z.infer<typeof AddressLabelResponseSchema>;
  readonly responseHash: `sha256:${string}`;
  readonly adapterVersion: 1;
}

export class NansenReadOnlyClient {
  readonly #endpoint: URL;
  readonly #timeoutMs: number;

  public constructor(
    private readonly options: NansenClientOptions,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.#endpoint = new URL(options.endpoint ?? "https://api.nansen.ai/api/v1/");
    if (this.#endpoint.protocol !== "https:") throw new Error("Nansen endpoint must use HTTPS");
    if (this.#endpoint.hostname !== "api.nansen.ai")
      throw new Error("Nansen endpoint host must be api.nansen.ai");
    if (!options.apiKey.trim()) throw new Error("Nansen API key is required");
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1000 || this.#timeoutMs > 30_000)
      throw new Error("Nansen timeout must be between 1000 and 30000ms");
  }

  public async smartMoneyHoldings(input: {
    readonly chain: "solana";
    readonly page?: number;
    readonly perPage?: number;
    readonly observedAt?: string;
  }): Promise<NansenEvidenceEnvelope> {
    const requestedAt = input.observedAt ?? new Date().toISOString();
    if (!Number.isFinite(new Date(requestedAt).getTime()))
      throw new Error("observedAt must be a valid timestamp");
    const request = nansenSmartMoneyHoldingsRequest(input);
    const response = await this.fetcher(new URL("smart-money/holdings", this.#endpoint), {
      method: "POST",
      headers: { "content-type": "application/json", apikey: this.options.apiKey },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) {
      const body = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 240);
      throw new NansenAccessError(response.status, body || response.statusText || "unknown error");
    }
    const payload = ResponseSchema.parse(await response.json());
    return {
      provider: "nansen",
      endpoint: "smart-money/holdings",
      requestedAt,
      receivedAt: new Date().toISOString(),
      request,
      response: payload,
      responseHash: contentHash(payload),
      adapterVersion: 1,
    };
  }

  public async addressLabels(input: {
    readonly address: string;
    readonly premium?: boolean;
    readonly page?: number;
    readonly perPage?: number;
    readonly observedAt?: string;
  }): Promise<NansenAddressLabelsEnvelope> {
    const requestedAt = input.observedAt ?? new Date().toISOString();
    if (!Number.isFinite(new Date(requestedAt).getTime()))
      throw new Error("observedAt must be a valid timestamp");
    const request = nansenAddressLabelsRequest(input);
    const endpoint = input.premium
      ? ("profiler/address/premium-labels" as const)
      : ("profiler/address/labels" as const);
    const response = await this.fetcher(new URL(endpoint, this.#endpoint), {
      method: "POST",
      headers: { "content-type": "application/json", apikey: this.options.apiKey },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) {
      const body = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 240);
      throw new NansenAccessError(response.status, body || response.statusText || "unknown error");
    }
    const payload = parseNansenAddressLabelsResponse(await response.json());
    return {
      provider: "nansen",
      endpoint,
      requestedAt,
      receivedAt: new Date().toISOString(),
      request,
      response: payload,
      responseHash: contentHash(payload),
      adapterVersion: 1,
    };
  }
}
