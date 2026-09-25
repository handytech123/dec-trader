import { z } from "zod";
import { WatchlistSchema, type Watchlist } from "./schemas.js";

const CoinMarketSchema = z
  .object({
    id: z.string().min(1),
    symbol: z.string().min(1),
    name: z.string().min(1),
    market_cap: z.number().nonnegative().nullable(),
    total_volume: z.number().nonnegative().nullable(),
  })
  .loose();

const CoinIdentitySchema = z
  .object({
    id: z.string().min(1),
    platforms: z.record(z.string(), z.string().nullable()),
  })
  .loose();

export interface UniverseCriteria {
  readonly minimumMarketCap: number;
  readonly maximumMarketCap: number;
  readonly minimumVolume24h: number;
  readonly limit: number;
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "autonomous-trading-lab/0.0.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`CoinGecko returned HTTP ${String(response.status)}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverSolanaUniverse(
  criteria: UniverseCriteria,
  timeoutMs = 20_000,
): Promise<Watchlist> {
  const [marketsPayload, identitiesPayload] = await Promise.all([
    fetchJson(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=solana-ecosystem&order=market_cap_desc&per_page=250&page=1&sparkline=false",
      timeoutMs,
    ),
    fetchJson("https://api.coingecko.com/api/v3/coins/list?include_platform=true", timeoutMs),
  ]);
  const markets = CoinMarketSchema.array().parse(marketsPayload);
  const identities = CoinIdentitySchema.array().parse(identitiesPayload);
  const sectors = [
    ["solana-meme-coins", "meme"],
    ["artificial-intelligence", "ai"],
    ["depin", "depin"],
    ["real-world-assets-rwa", "rwa"],
    ["decentralized-exchange", "dex"],
    ["decentralized-finance-defi", "defi"],
    ["gaming", "gaming"],
    ["liquid-staking-tokens", "liquid-staking"],
  ] as const;
  const sectorMembership = new Map<string, string>();
  const sectorResults = await Promise.all(
    sectors.map(async ([categoryId, label]) => {
      try {
        const payload = await fetchJson(
          `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=${categoryId}&order=market_cap_desc&per_page=250&page=1&sparkline=false`,
          timeoutMs,
        );
        return { label, markets: CoinMarketSchema.array().parse(payload) };
      } catch {
        // Sector enrichment is advisory; base universe discovery remains available
        // if a free provider rate-limits one category endpoint.
        return { label, markets: [] };
      }
    }),
  );
  for (const sector of sectorResults) {
    for (const market of sector.markets) {
      if (!sectorMembership.has(market.id)) sectorMembership.set(market.id, sector.label);
    }
  }
  const solanaMintById = new Map<string, string>();
  for (const identity of identities) {
    const mint = identity.platforms.solana;
    if (mint) solanaMintById.set(identity.id, mint);
  }
  const excludedSymbols = new Set(["usdc", "usdt", "pyusd", "usds", "dai", "wbtc", "weth"]);
  const benchmarkSymbols = new Set(["sol", "wsol"]);
  const controlSymbols = new Set([
    "eurc",
    "usdgo",
    "susde",
    "jitosol",
    "bnsol",
    "jupsol",
    "syrupusdc",
    "lbtc",
    "tbtc",
    "ausd",
    "usx",
    "reusd",
    "apxusd",
  ]);
  const candidates = markets
    .filter((market) => {
      const cap = market.market_cap ?? 0;
      return (
        cap >= criteria.minimumMarketCap &&
        cap <= criteria.maximumMarketCap &&
        (market.total_volume ?? 0) >= criteria.minimumVolume24h &&
        !excludedSymbols.has(market.symbol.toLowerCase()) &&
        solanaMintById.has(market.id)
      );
    })
    .sort((left, right) => (right.market_cap ?? 0) - (left.market_cap ?? 0))
    .slice(0, criteria.limit)
    .map((market) => {
      const mint = solanaMintById.get(market.id);
      if (!mint) throw new Error(`missing Solana mint after filtering: ${market.id}`);
      const cap = market.market_cap ?? 0;
      return {
        mint,
        symbol: market.symbol.toUpperCase(),
        category: sectorMembership.get(market.id) ?? "other-solana",
        marketCapTier: cap < 300_000_000 ? "small" : "mid",
        researchRole: benchmarkSymbols.has(market.symbol.toLowerCase())
          ? ("BENCHMARK" as const)
          : controlSymbols.has(market.symbol.toLowerCase())
            ? ("CONTROL" as const)
            : ("CANDIDATE" as const),
      };
    });
  return WatchlistSchema.parse({ version: "1", chain: "solana", assets: candidates });
}
