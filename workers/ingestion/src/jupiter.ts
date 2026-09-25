import { contentHash } from "@autonomous-trading-lab/domain";
import { Decimal } from "decimal.js";
import { z } from "zod";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const QuoteSchema = z
  .object({
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: z.string().regex(/^\d+$/),
    outAmount: z.string().regex(/^\d+$/),
    priceImpactPct: z.string(),
    routePlan: z.array(z.unknown()),
  })
  .loose();

export interface RouteAssessment {
  readonly mint: string;
  readonly status: "PASS" | "REVIEW" | "BLOCK";
  readonly reason: string | null;
  readonly notionalUsdcAtomic: string;
  readonly buyOutputAtomic: string | null;
  readonly sellOutputUsdcAtomic: string | null;
  readonly roundTripLossBps: string | null;
  readonly buyPriceImpactPct: string | null;
  readonly sellPriceImpactPct: string | null;
  readonly rawHash: `sha256:${string}` | null;
}

async function quote(
  inputMint: string,
  outputMint: string,
  amount: string,
  fetcher: typeof fetch,
): Promise<z.infer<typeof QuoteSchema>> {
  const query = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: "100",
    restrictIntermediateTokens: "true",
  });
  const response = await fetcher(`https://lite-api.jup.ag/swap/v1/quote?${query.toString()}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`quote HTTP ${String(response.status)}`);
  return QuoteSchema.parse(await response.json());
}

export async function assessRoundTripRoute(
  mint: string,
  notionalUsdcAtomic = "100000000",
  fetcher: typeof fetch = fetch,
): Promise<RouteAssessment> {
  try {
    const buy = await quote(USDC_MINT, mint, notionalUsdcAtomic, fetcher);
    if (new Decimal(buy.outAmount).isZero()) throw new Error("buy route returned zero output");
    const sell = await quote(mint, USDC_MINT, buy.outAmount, fetcher);
    const loss = Decimal.max(new Decimal(notionalUsdcAtomic).minus(sell.outAmount), 0)
      .div(notionalUsdcAtomic)
      .mul(10_000);
    const largestImpact = Decimal.max(buy.priceImpactPct, sell.priceImpactPct);
    const review = loss.greaterThan(500) || largestImpact.greaterThan(0.03);
    return {
      mint,
      status: review ? "REVIEW" : "PASS",
      reason: review ? "ROUND_TRIP_COST_OR_IMPACT" : null,
      notionalUsdcAtomic,
      buyOutputAtomic: buy.outAmount,
      sellOutputUsdcAtomic: sell.outAmount,
      roundTripLossBps: loss.toString(),
      buyPriceImpactPct: buy.priceImpactPct,
      sellPriceImpactPct: sell.priceImpactPct,
      rawHash: contentHash({ buy, sell }),
    };
  } catch (error: unknown) {
    return {
      mint,
      status: "BLOCK",
      reason: error instanceof Error ? error.message : String(error),
      notionalUsdcAtomic,
      buyOutputAtomic: null,
      sellOutputUsdcAtomic: null,
      roundTripLossBps: null,
      buyPriceImpactPct: null,
      sellPriceImpactPct: null,
      rawHash: null,
    };
  }
}

export async function assessRoutes(
  mints: readonly string[],
  concurrency = 3,
): Promise<readonly RouteAssessment[]> {
  const pending = mints.map((mint, index) => ({ mint, index }));
  const completed: { index: number; result: RouteAssessment }[] = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, mints.length) }, async () => {
      for (;;) {
        const task = pending.shift();
        if (!task) return;
        completed.push({ index: task.index, result: await assessRoundTripRoute(task.mint) });
      }
    }),
  );
  return completed.sort((left, right) => left.index - right.index).map((item) => item.result);
}
