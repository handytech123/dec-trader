import { DexPairSchema, type DexPair } from "./schemas.js";

export interface PairProvider {
  tokenPairs(mint: string, timeoutMs: number): Promise<readonly DexPair[]>;
}

export class DexScreenerProvider implements PairProvider {
  public async tokenPairs(mint: string, timeoutMs: number): Promise<readonly DexPair[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetch(
        `https://api.dexscreener.com/token-pairs/v1/solana/${encodeURIComponent(mint)}`,
        { headers: { accept: "application/json" }, signal: controller.signal },
      );
      if (!response.ok) throw new Error(`DEX Screener returned HTTP ${String(response.status)}`);
      const payload: unknown = await response.json();
      return DexPairSchema.array().parse(payload);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function selectExactPools(
  mint: string,
  pairs: readonly DexPair[],
  topPools: number,
): readonly DexPair[] {
  return pairs
    .filter(
      (pair) =>
        pair.chainId === "solana" &&
        (pair.baseToken.address === mint || pair.quoteToken.address === mint),
    )
    .sort((left, right) => {
      const liquidityDifference = (right.liquidity?.usd ?? 0) - (left.liquidity?.usd ?? 0);
      if (liquidityDifference !== 0) return liquidityDifference;
      return `${left.dexId}:${left.pairAddress}`.localeCompare(
        `${right.dexId}:${right.pairAddress}`,
      );
    })
    .slice(0, topPools);
}
