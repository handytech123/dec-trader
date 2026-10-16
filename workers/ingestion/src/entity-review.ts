import { z } from "zod";
import { IsoTimestampSchema, Sha256Schema } from "@autonomous-trading-lab/domain";
import { SolanaAddressSchema } from "@autonomous-trading-lab/capital-flow";

const IdentityFields = {
  proposedEntityType: z.enum(["EXCHANGE", "BRIDGE", "PROTOCOL", "CONTRACT", "POOL"]).optional(),
  proposedLabel: z.string().min(1).max(128).optional(),
  source: z.string().min(1).max(100).optional(),
  sourceUrl: z.url().max(2048).optional(),
  evidenceHash: Sha256Schema.optional(),
  validFrom: IsoTimestampSchema.optional(),
} as const;

export const EntityVerificationReviewSchema = z
  .object({
    address: SolanaAddressSchema,
    status: z.enum(["PENDING", "VERIFIED", "REJECTED", "DEFERRED"]),
    decidedAt: IsoTimestampSchema,
    reviewer: z.string().min(1).max(100),
    rationale: z.string().min(1).max(2_000),
    ...IdentityFields,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status !== "VERIFIED") return;
    const missing = [
      ["proposedEntityType", value.proposedEntityType],
      ["proposedLabel", value.proposedLabel],
      ["source", value.source],
      ["sourceUrl", value.sourceUrl],
      ["evidenceHash", value.evidenceHash],
      ["validFrom", value.validFrom],
    ] as const;
    for (const [field, fieldValue] of missing)
      if (fieldValue === undefined)
        context.addIssue({ code: "custom", path: [field], message: "required for VERIFIED" });
  });

export type EntityVerificationReview = z.infer<typeof EntityVerificationReviewSchema>;

export const EntityVerificationReviewFileSchema = z
  .object({
    reviewVersion: z.literal("1"),
    reviews: z.array(EntityVerificationReviewSchema).min(1).max(10_000),
  })
  .strict();
