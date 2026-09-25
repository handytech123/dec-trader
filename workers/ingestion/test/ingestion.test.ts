import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { contentHash } from "@autonomous-trading-lab/domain";
import { captureWatchlist, captureWatchlistDetailed } from "../src/capture.js";
import { selectExactPools, type PairProvider } from "../src/dexscreener.js";
import { ResearchDatabase, toIsoTimestamp } from "../src/database.js";
import { deterministicDomainId } from "../src/ids.js";
import { CaptureRecordSchema, type DexPair, type Watchlist } from "../src/schemas.js";

const mint = "So11111111111111111111111111111111111111112";
const quote = "EPjFWdd5AufqSSqeM2q9XcZ5NdfK3xVqE5Y5tJp7mZr";
const pair = (pairAddress: string, liquidity: number, baseAddress = mint): DexPair => ({
  chainId: "solana",
  dexId: "fixture-dex",
  pairAddress,
  baseToken: { address: baseAddress, symbol: "BASE" },
  quoteToken: { address: quote, symbol: "USDC" },
  priceUsd: "1.25",
  liquidity: { usd: liquidity },
  volume: { h24: 12_345 },
  priceChange: { m5: 1, h1: 2, h6: 3, h24: 4 },
  txns: { h24: { buys: 20, sells: 10 } },
  marketCap: 1_000_000,
  fdv: 2_000_000,
  pairCreatedAt: 1_700_000_000_000,
});

describe("DEX ingestion", () => {
  it("normalizes local GMT-offset database timestamps before SQL reuse", () => {
    expect(toIsoTimestamp("Wed Sep 24 2026 00:27:15 GMT-0500 (Central Daylight Time)")).toBe(
      "2026-09-24T05:27:15.000Z",
    );
  });

  it("selects only exact-address Solana pools in deterministic liquidity order", () => {
    const selected = selectExactPools(
      mint,
      [
        pair("low", 10),
        pair("wrong-token", 10_000, "11111111111111111111111111111111"),
        { ...pair("wrong-chain", 20_000), chainId: "ethereum" },
        pair("high", 100),
      ],
      2,
    );
    expect(selected.map((item) => item.pairAddress)).toEqual(["high", "low"]);
  });

  it("produces hash-bound raw and rich normalized capture records", async () => {
    const watchlist: Watchlist = {
      version: "1",
      chain: "solana",
      assets: [{ mint, symbol: "TEST", category: "defi", marketCapTier: "small" }],
    };
    const provider: PairProvider = {
      tokenPairs: () => Promise.resolve([pair("pool-1", 75_000)]),
    };
    const records = await captureWatchlist(watchlist, provider, {
      topPools: 3,
      timeoutMs: 1_000,
      capturedAt: "2026-09-24T05:00:00.000Z",
    });
    expect(records).toHaveLength(1);
    const record = CaptureRecordSchema.parse(records[0]);
    expect(record.normalized.liquidity).toBe("75000");
    expect(record.market.category).toBe("defi");
    expect(record.market.buys24h).toBe(20);
    expect(record.raw.payloadHash).toBe(contentHash(record.raw.payload));
  });

  it("emits no observation when the provider does not return the configured mint", async () => {
    const watchlist: Watchlist = {
      version: "1",
      chain: "solana",
      assets: [{ mint }],
    };
    const provider: PairProvider = {
      tokenPairs: () => Promise.resolve([pair("wrong", 100, "11111111111111111111111111111111")]),
    };
    const records = await captureWatchlist(watchlist, provider, {
      topPools: 3,
      timeoutMs: 1_000,
      capturedAt: "2026-09-24T05:00:00.000Z",
    });
    expect(records).toEqual([]);
  });

  it("isolates provider failures and continues collecting other assets", async () => {
    const secondMint = "11111111111111111111111111111111";
    const watchlist: Watchlist = {
      version: "1",
      chain: "solana",
      assets: [{ mint }, { mint: secondMint }],
    };
    const provider: PairProvider = {
      tokenPairs: (requestedMint) =>
        requestedMint === mint
          ? Promise.reject(new Error("rate limited"))
          : Promise.resolve([pair("second", 100, secondMint)]),
    };
    const result = await captureWatchlistDetailed(watchlist, provider, {
      topPools: 3,
      timeoutMs: 1_000,
      capturedAt: "2026-09-24T05:00:00.000Z",
    });
    expect(result.records).toHaveLength(1);
    expect(result.failures).toEqual([
      expect.objectContaining({ mint, errorCode: "PROVIDER_ERROR", message: "rate limited" }),
    ]);
  });

  it("migrates and persists captures idempotently in the research database", async () => {
    const database = new ResearchDatabase("memory://");
    try {
      const migrations = fileURLToPath(
        new URL("../../../infra/postgres/migrations/", import.meta.url),
      );
      await database.migrate(migrations);
      const watchlist: Watchlist = {
        version: "1",
        chain: "solana",
        assets: [{ mint, symbol: "TEST", category: "defi", marketCapTier: "small" }],
      };
      const provider: PairProvider = {
        tokenPairs: () => Promise.resolve([pair("persisted-pool", 75_000)]),
      };
      const capturedAt = "2026-09-24T05:00:00.000Z";
      const result = await captureWatchlistDetailed(watchlist, provider, {
        topPools: 1,
        timeoutMs: 1_000,
        capturedAt,
      });
      await database.persistCapture(
        {
          collectionRunId: deterministicDomainId("collection", capturedAt),
          source: "dexscreener-token-pairs-v1",
          startedAt: capturedAt,
          completedAt: "2026-09-24T05:00:01.000Z",
          requestedAssets: 1,
          capturedObservations: 1,
          errorCount: 0,
          status: "COMPLETED",
          details: {},
        },
        result.records,
      );
      expect(await database.computeAndPersistFeatures()).toBe(1);
      expect(await database.computeAndPersistFeatures()).toBe(0);
      expect(await database.runShadowCycle("2026-09-24T05:00:02.000Z")).toEqual(
        expect.objectContaining({ entered: 0, noTrade: 1, closed: 0 }),
      );
      expect(await database.health()).toEqual({
        assets: 1,
        pools: 1,
        observations: 1,
        collectionErrors: 0,
        featureSnapshots: 1,
        forwardOutcomes: 0,
        routeAssessments: 0,
        integrityAssessments: 0,
        shadowDecisions: 1,
        paperPositions: 0,
        lastObservationAt: capturedAt,
      });
    } finally {
      await database.close();
    }
  });
});
