import { contentHash } from "@autonomous-trading-lab/domain";
import { z } from "zod";

const TokenSchema = z
  .object({
    id: z.string(),
    holderCount: z.number().int().nonnegative().nullable().optional(),
    organicScore: z.number().nonnegative().nullable().optional(),
    organicScoreLabel: z.string().nullable().optional(),
    isVerified: z.boolean().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
    audit: z
      .object({
        topHoldersPercentage: z.number().nonnegative().nullable().optional(),
        isSus: z.boolean().nullable().optional(),
      })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();

export interface MarketIntegrityAssessment {
  readonly mint: string;
  readonly status: "PASS" | "REVIEW" | "BLOCK";
  readonly reasons: readonly string[];
  readonly holderCount: number | null;
  readonly topHoldersPercentage: number | null;
  readonly organicScore: number | null;
  readonly organicScoreLabel: string | null;
  readonly isVerified: boolean | null;
  readonly isSuspicious: boolean | null;
  readonly providerUpdatedAt: string | null;
  readonly rawHash: `sha256:${string}` | null;
}

export function classifyMarketIntegrity(
  token: z.infer<typeof TokenSchema>,
): MarketIntegrityAssessment {
  const holderCount = token.holderCount ?? null;
  const concentration = token.audit?.topHoldersPercentage ?? null;
  const suspicious = token.audit?.isSus ?? null;
  const reasons: string[] = [];
  if (suspicious === true) reasons.push("PROVIDER_SUSPICIOUS");
  if (concentration === null) reasons.push("CONCENTRATION_UNAVAILABLE");
  else if (concentration >= 80) reasons.push("EXTREME_TOP_HOLDER_CONCENTRATION");
  else if (concentration >= 50) reasons.push("HIGH_TOP_HOLDER_CONCENTRATION");
  if (holderCount === null) reasons.push("HOLDER_COUNT_UNAVAILABLE");
  else if (holderCount < 1_000) reasons.push("LOW_HOLDER_COUNT");
  if (token.isVerified !== true) reasons.push("NOT_VERIFIED");
  if ((token.organicScore ?? 0) < 30 || token.organicScoreLabel === "low")
    reasons.push("LOW_ORGANIC_SCORE");
  const block = suspicious === true || (concentration !== null && concentration >= 80);
  const values = {
    mint: token.id,
    status: block ? ("BLOCK" as const) : reasons.length ? ("REVIEW" as const) : ("PASS" as const),
    reasons,
    holderCount,
    topHoldersPercentage: concentration,
    organicScore: token.organicScore ?? null,
    organicScoreLabel: token.organicScoreLabel ?? null,
    isVerified: token.isVerified ?? null,
    isSuspicious: suspicious,
    providerUpdatedAt: token.updatedAt ?? null,
  };
  return { ...values, rawHash: contentHash(token) };
}

export async function assessMarketIntegrity(
  mint: string,
  fetcher: typeof fetch = fetch,
): Promise<MarketIntegrityAssessment> {
  try {
    const response = await fetcher(
      `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error(`token info HTTP ${String(response.status)}`);
    const tokens = TokenSchema.array().parse(await response.json());
    const exact = tokens.find((token) => token.id === mint);
    if (!exact) throw new Error("exact mint missing from token search response");
    return classifyMarketIntegrity(exact);
  } catch (error: unknown) {
    return {
      mint,
      status: "REVIEW",
      reasons: [`PROVIDER_ERROR:${error instanceof Error ? error.message : String(error)}`],
      holderCount: null,
      topHoldersPercentage: null,
      organicScore: null,
      organicScoreLabel: null,
      isVerified: null,
      isSuspicious: null,
      providerUpdatedAt: null,
      rawHash: null,
    };
  }
}

export async function assessMarketIntegrityBatch(
  mints: readonly string[],
  concurrency = 3,
): Promise<readonly MarketIntegrityAssessment[]> {
  const pending = mints.map((mint, index) => ({ mint, index }));
  const completed: { index: number; result: MarketIntegrityAssessment }[] = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, mints.length) }, async () => {
      for (;;) {
        const task = pending.shift();
        if (!task) return;
        completed.push({ index: task.index, result: await assessMarketIntegrity(task.mint) });
      }
    }),
  );
  return completed.sort((left, right) => left.index - right.index).map((item) => item.result);
}
