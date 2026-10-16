import { z } from "zod";

export const CapabilitySchema = z.enum([
  "CHAIN_BLOCKS",
  "CHAIN_TRANSFERS",
  "CHAIN_STREAM",
  "MARKET_INSTRUMENTS",
  "MARKET_TRADES",
  "MARKET_ORDER_BOOK",
  "ENTITY_ATTRIBUTION",
  "RESEARCH_QUERY",
]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const ProviderHealthSchema = z
  .object({
    status: z.enum(["HEALTHY", "DEGRADED", "UNAVAILABLE"]),
    checkedAt: z.iso.datetime({ offset: true }),
    message: z.string().max(500).optional(),
  })
  .strict();
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;

export const ProviderMetadataSchema = z
  .object({
    rateLimitPerMinute: z.number().int().positive().optional(),
    freshnessSeconds: z.number().int().nonnegative(),
    retryPolicy: z.enum(["NONE", "BOUNDED_EXPONENTIAL"]),
    licenseTag: z.string().min(1).max(100).optional(),
  })
  .strict();
export type ProviderMetadata = z.infer<typeof ProviderMetadataSchema>;

export interface ProviderAdapter {
  providerId(): string;
  capabilities(): readonly Capability[];
  health(): Promise<ProviderHealth>;
  metadata(): ProviderMetadata;
}

export interface Subscription {
  close(): Promise<void>;
}

export interface RawBlock {
  readonly providerRef: string;
  readonly chain: string;
  readonly sequence: string;
  readonly sourceTimestamp: string;
  readonly payload: unknown;
}

export interface RawTransfer {
  readonly providerRef: string;
  readonly chain: string;
  readonly sourceTimestamp: string;
  readonly payload: unknown;
}

export interface Instrument {
  readonly instrumentRef: string;
  readonly baseAssetRef: string;
  readonly quoteAssetRef: string;
  readonly status: "ACTIVE" | "INACTIVE";
}

export interface RawTrade {
  readonly providerRef: string;
  readonly sourceTimestamp: string;
  readonly sequence?: string;
  readonly payload: unknown;
}

export interface RawOrderBookEvent {
  readonly providerRef: string;
  readonly sourceTimestamp: string;
  readonly sequence: string;
  readonly payload: unknown;
}

export interface EntityAttribution {
  readonly providerRef: string;
  readonly address: string;
  readonly chain: string;
  readonly label: string;
  readonly confidence: number;
  readonly payload: unknown;
}

export interface ResearchQuerySpec {
  readonly queryId: string;
  readonly parameters: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ResearchResult {
  readonly providerRef: string;
  readonly retrievedAt: string;
  readonly payload: unknown;
}

export interface ChainProvider extends ProviderAdapter {
  getBlock(reference: string): Promise<RawBlock>;
  getTransfers(query: Readonly<Record<string, string>>): Promise<readonly RawTransfer[]>;
  streamEvents(
    filter: Readonly<Record<string, string>>,
    handler: (event: RawBlock | RawTransfer) => Promise<void>,
  ): Promise<Subscription>;
}

export interface MarketProvider extends ProviderAdapter {
  getInstruments(): Promise<readonly Instrument[]>;
  streamTrades(symbol: string, handler: (trade: RawTrade) => Promise<void>): Promise<Subscription>;
  streamOrderBook(
    symbol: string,
    handler: (event: RawOrderBookEvent) => Promise<void>,
  ): Promise<Subscription>;
}

export interface EntityIntelProvider extends ProviderAdapter {
  lookupAddress(address: string, chain: string): Promise<readonly EntityAttribution[]>;
}

export interface ResearchQueryProvider extends ProviderAdapter {
  execute(query: ResearchQuerySpec): Promise<ResearchResult>;
}

export function validateProviderDescriptor(provider: ProviderAdapter): Promise<ProviderHealth> {
  const providerId = provider.providerId();
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(providerId))
    throw new Error("providerId must be a stable lowercase identifier");
  const capabilities = CapabilitySchema.array().min(1).parse(provider.capabilities());
  if (new Set(capabilities).size !== capabilities.length)
    throw new Error("provider capabilities must be unique");
  ProviderMetadataSchema.parse(provider.metadata());
  return provider.health().then((health) => ProviderHealthSchema.parse(health));
}
