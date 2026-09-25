import { z } from "zod";
import {
  MarketObservationSchema,
  RawObservationSchema,
} from "@autonomous-trading-lab/data-foundation";
import { IsoTimestampSchema, Sha256Schema } from "@autonomous-trading-lab/domain";

const MintSchema = z
  .string()
  .min(32)
  .max(44)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
const DecimalOrNullSchema = z.union([
  z
    .string()
    .max(128)
    // Anchored canonical decimal grammar over a length-bounded string.
    // eslint-disable-next-line security/detect-unsafe-regex
    .regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/),
  z.null(),
]);

export const WatchlistSchema = z
  .object({
    version: z.literal("1"),
    chain: z.literal("solana"),
    assets: z
      .array(
        z
          .object({
            mint: MintSchema,
            symbol: z.string().min(1).max(32).optional(),
            category: z.string().min(1).max(64).optional(),
            marketCapTier: z.string().min(1).max(32).optional(),
            researchRole: z.enum(["CANDIDATE", "BENCHMARK", "CONTROL"]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict()
  .superRefine((watchlist, context) => {
    const seen = new Set<string>();
    for (const [index, asset] of watchlist.assets.entries()) {
      if (seen.has(asset.mint)) {
        context.addIssue({
          code: "custom",
          path: ["assets", index, "mint"],
          message: "duplicate mint",
        });
      }
      seen.add(asset.mint);
    }
  });
export type Watchlist = z.infer<typeof WatchlistSchema>;
export type WatchlistAsset = Watchlist["assets"][number];

export const DexTokenSchema = z
  .object({ address: MintSchema, name: z.string().optional(), symbol: z.string().optional() })
  .loose();

export const DexPairSchema = z
  .object({
    chainId: z.string(),
    dexId: z.string(),
    pairAddress: z.string().min(1),
    baseToken: DexTokenSchema,
    quoteToken: DexTokenSchema,
    priceUsd: z.string().nullable().optional(),
    liquidity: z.object({ usd: z.number().nonnegative().nullable().optional() }).loose().optional(),
    volume: z.record(z.string(), z.number()).optional(),
    priceChange: z.record(z.string(), z.number()).nullable().optional(),
    txns: z
      .record(
        z.string(),
        z.object({ buys: z.number().int().nonnegative(), sells: z.number().int().nonnegative() }),
      )
      .optional(),
    fdv: z.number().nonnegative().nullable().optional(),
    marketCap: z.number().nonnegative().nullable().optional(),
    pairCreatedAt: z.number().int().nonnegative().nullable().optional(),
  })
  .loose();
export type DexPair = z.infer<typeof DexPairSchema>;

export const RichMarketFieldsSchema = z
  .object({
    configuredMint: MintSchema,
    configuredSymbol: z.string().nullable(),
    category: z.string().nullable(),
    marketCapTier: z.string().nullable(),
    researchRole: z.enum(["CANDIDATE", "BENCHMARK", "CONTROL"]),
    dexId: z.string(),
    pairAddress: z.string(),
    baseMint: MintSchema,
    quoteMint: MintSchema,
    volume24h: DecimalOrNullSchema,
    marketCap: DecimalOrNullSchema,
    fdv: DecimalOrNullSchema,
    priceChange5m: DecimalOrNullSchema,
    priceChange1h: DecimalOrNullSchema,
    priceChange6h: DecimalOrNullSchema,
    priceChange24h: DecimalOrNullSchema,
    buys5m: z.number().int().nonnegative().nullable(),
    sells5m: z.number().int().nonnegative().nullable(),
    buys1h: z.number().int().nonnegative().nullable(),
    sells1h: z.number().int().nonnegative().nullable(),
    buys6h: z.number().int().nonnegative().nullable(),
    sells6h: z.number().int().nonnegative().nullable(),
    buys24h: z.number().int().nonnegative().nullable(),
    sells24h: z.number().int().nonnegative().nullable(),
    pairCreatedAt: IsoTimestampSchema.nullable(),
  })
  .strict();

export const CaptureRecordSchema = z
  .object({
    captureVersion: z.literal("1"),
    capturedAt: IsoTimestampSchema,
    raw: RawObservationSchema,
    normalized: MarketObservationSchema,
    market: RichMarketFieldsSchema,
    recordHash: Sha256Schema,
  })
  .strict();
export type CaptureRecord = z.infer<typeof CaptureRecordSchema>;
