import { z } from "zod";
import { contentHash, Sha256Schema } from "@autonomous-trading-lab/domain";

const HashSchema = Sha256Schema.transform((value) => value as `sha256:${string}`);

export const ResearchProtocolSchema = z
  .object({
    protocolId: z.string().regex(/^protocol_[0-9A-Z]{26}$/),
    name: z.string().min(1).max(200),
    version: z.string().regex(/^[1-9][0-9]*$/),
    objective: z.string().min(1).max(2000),
    families: z
      .array(
        z
          .object({
            family: z.enum([
              "TRANSFER_MAGNITUDE",
              "DIRECTION",
              "WALLET_BEHAVIOR",
              "MARKET_REACTION",
              "CONDITIONAL_COMBINATION",
              "PROTOCOL_FLOW",
              "FALSIFICATION",
            ]),
            hypothesis: z.string().min(1).max(2000),
            features: z.array(z.string().min(1).max(100)).min(1),
            thresholds: z.array(z.string().min(1).max(100)),
          })
          .strict(),
      )
      .min(2)
      .max(6),
    horizons: z.array(z.enum(["1m", "5m", "15m", "1h", "6h", "24h"])).min(1),
    requiredControls: z
      .array(
        z.enum([
          "RANDOMIZED_TIMESTAMPS",
          "UNCONDITIONAL_SOL",
          "BTC_MARKET",
          "REGIME_STRATIFICATION",
          "REMOVE_LARGEST_FIVE",
          "WALK_FORWARD_HOLDOUT",
          "TRADING_COSTS",
        ]),
      )
      .min(5),
    multipleTestingMethod: z.enum(["BENJAMINI_HOCHBERG", "HOLM_BONFERRONI"]),
    falseDiscoveryRate: z.number().gt(0).lte(0.1),
    minimumSampleSize: z.number().int().min(30),
    holdoutFraction: z.number().gt(0).lt(0.5),
    seed: z.string().regex(/^(0|[1-9][0-9]*)$/),
    datasetCutoff: z.iso.datetime({ offset: true }),
    frozenAt: z.iso.datetime({ offset: true }),
    codeHash: HashSchema,
    contentHash: HashSchema,
  })
  .strict()
  .superRefine((protocol, context) => {
    const familyNames = protocol.families.map((item) => item.family);
    const families = new Set(familyNames);
    if (families.size !== familyNames.length)
      context.addIssue({
        code: "custom",
        path: ["families"],
        message: "research families must be unique",
      });
    const expected: readonly (typeof familyNames)[number][] = families.has("PROTOCOL_FLOW")
      ? ["PROTOCOL_FLOW", "FALSIFICATION"]
      : [
          "TRANSFER_MAGNITUDE",
          "DIRECTION",
          "WALLET_BEHAVIOR",
          "MARKET_REACTION",
          "CONDITIONAL_COMBINATION",
          "FALSIFICATION",
        ];
    if (families.size !== expected.length || expected.some((family) => !families.has(family)))
      context.addIssue({
        code: "custom",
        path: ["families"],
        message: "protocol must contain exactly one complete registered family profile",
      });
    const { contentHash: claimed, ...body } = protocol;
    if (contentHash(body) !== claimed)
      context.addIssue({ code: "custom", path: ["contentHash"], message: "content hash mismatch" });
  });
export type ResearchProtocol = z.infer<typeof ResearchProtocolSchema>;

export function finalizeResearchProtocol(
  candidate: Omit<ResearchProtocol, "contentHash">,
): ResearchProtocol {
  return ResearchProtocolSchema.parse({ ...candidate, contentHash: contentHash(candidate) });
}
