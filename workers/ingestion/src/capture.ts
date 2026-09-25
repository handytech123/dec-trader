import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { contentHash } from "@autonomous-trading-lab/domain";
import { normalizeObservation, type RawObservation } from "@autonomous-trading-lab/data-foundation";
import { selectExactPools, type PairProvider } from "./dexscreener.js";
import { deterministicDomainId } from "./ids.js";
import {
  CaptureRecordSchema,
  type CaptureRecord,
  type DexPair,
  type Watchlist,
  type WatchlistAsset,
} from "./schemas.js";

const decimal = (value: number | string | null | undefined): string | null => {
  if (value === null || value === undefined || value === "") return null;
  const result = typeof value === "number" ? value.toString() : value;
  if (!Number.isFinite(Number(result)) || Number(result) < 0) return null;
  return result;
};

const count = (pair: DexPair, window: string, side: "buys" | "sells"): number | null => {
  // Window is an internal constant, never a provider- or user-controlled property name.
  // eslint-disable-next-line security/detect-object-injection
  const windowCounts = pair.txns?.[window];
  if (windowCounts === undefined) return null;
  return side === "buys" ? windowCounts.buys : windowCounts.sells;
};

function buildRecord(asset: WatchlistAsset, pair: DexPair, capturedAt: string): CaptureRecord {
  const sourceId = `solana:${pair.dexId}:${pair.pairAddress}:${capturedAt}`;
  const rawBody = {
    observationId: deterministicDomainId("observation", sourceId),
    ingestionId: deterministicDomainId("ingestion", capturedAt),
    source: "dexscreener-token-pairs-v1",
    sourceId,
    observedAt: capturedAt,
    sourceTime: capturedAt,
    schemaVersion: "1",
    payload: pair,
    payloadHash: contentHash(pair),
  } satisfies RawObservation;
  const rawHash = contentHash(rawBody);
  const normalized = normalizeObservation(rawBody, {
    source: rawBody.source,
    normalize: (raw) => ({
      observationId: raw.observationId,
      rawObservationHash: contentHash(raw),
      assetId: deterministicDomainId("asset", `solana:${asset.mint}`),
      poolId: deterministicDomainId("pool", `solana:${pair.dexId}:${pair.pairAddress}`),
      price: decimal(pair.priceUsd) ?? "0",
      volume: decimal(pair.volume?.h24) ?? "0",
      liquidity: decimal(pair.liquidity?.usd) ?? "0",
      observedAt: raw.observedAt,
      sourceTime: raw.sourceTime,
      source: raw.source,
      schemaVersion: "1",
    }),
  });
  const pairCreatedAt = pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : null;
  const market = {
    configuredMint: asset.mint,
    configuredSymbol: asset.symbol ?? null,
    category: asset.category ?? null,
    marketCapTier: asset.marketCapTier ?? null,
    researchRole: asset.researchRole ?? "CANDIDATE",
    dexId: pair.dexId,
    pairAddress: pair.pairAddress,
    baseMint: pair.baseToken.address,
    quoteMint: pair.quoteToken.address,
    volume24h: decimal(pair.volume?.h24),
    marketCap: decimal(pair.marketCap),
    fdv: decimal(pair.fdv),
    priceChange5m: decimal(pair.priceChange?.m5),
    priceChange1h: decimal(pair.priceChange?.h1),
    priceChange6h: decimal(pair.priceChange?.h6),
    priceChange24h: decimal(pair.priceChange?.h24),
    buys5m: count(pair, "m5", "buys"),
    sells5m: count(pair, "m5", "sells"),
    buys1h: count(pair, "h1", "buys"),
    sells1h: count(pair, "h1", "sells"),
    buys6h: count(pair, "h6", "buys"),
    sells6h: count(pair, "h6", "sells"),
    buys24h: count(pair, "h24", "buys"),
    sells24h: count(pair, "h24", "sells"),
    pairCreatedAt,
  };
  const body = { captureVersion: "1" as const, capturedAt, raw: rawBody, normalized, market };
  return CaptureRecordSchema.parse({ ...body, recordHash: contentHash({ ...body, rawHash }) });
}

export interface CaptureOptions {
  readonly topPools: number;
  readonly timeoutMs: number;
  readonly capturedAt?: string;
}

export interface CaptureFailure {
  readonly mint: string;
  readonly occurredAt: string;
  readonly errorCode: "PROVIDER_ERROR" | "NO_EXACT_POOL" | "NORMALIZATION_ERROR";
  readonly message: string;
}

export interface CaptureResult {
  readonly records: readonly CaptureRecord[];
  readonly failures: readonly CaptureFailure[];
}

export async function captureWatchlistDetailed(
  watchlist: Watchlist,
  provider: PairProvider,
  options: CaptureOptions,
): Promise<CaptureResult> {
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const records: CaptureRecord[] = [];
  const failures: CaptureFailure[] = [];
  for (const asset of watchlist.assets) {
    let pairs: readonly DexPair[];
    try {
      pairs = await provider.tokenPairs(asset.mint, options.timeoutMs);
    } catch (error: unknown) {
      failures.push({
        mint: asset.mint,
        occurredAt: capturedAt,
        errorCode: "PROVIDER_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const selected = selectExactPools(asset.mint, pairs, options.topPools);
    if (selected.length === 0) {
      failures.push({
        mint: asset.mint,
        occurredAt: capturedAt,
        errorCode: "NO_EXACT_POOL",
        message: "provider returned no exact-address Solana pool",
      });
      continue;
    }
    for (const pair of selected) {
      try {
        records.push(buildRecord(asset, pair, capturedAt));
      } catch (error: unknown) {
        failures.push({
          mint: asset.mint,
          occurredAt: capturedAt,
          errorCode: "NORMALIZATION_ERROR",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { records, failures };
}

export async function captureWatchlist(
  watchlist: Watchlist,
  provider: PairProvider,
  options: CaptureOptions,
): Promise<readonly CaptureRecord[]> {
  return (await captureWatchlistDetailed(watchlist, provider, options)).records;
}

export async function appendCaptureSpool(
  outputPath: string,
  records: readonly CaptureRecord[],
): Promise<void> {
  if (records.length === 0) return;
  // The caller supplies a local research-spool path; parent creation is intentional.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(dirname(outputPath), { recursive: true });
  const lines = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await appendFile(outputPath, lines, { encoding: "utf8", flag: "a" });
}
