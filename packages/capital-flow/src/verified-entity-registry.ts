import { z } from "zod";
import { IsoTimestampSchema, Sha256Schema } from "@autonomous-trading-lab/domain";

export const SolanaAddressSchema = z
  .string()
  .min(32)
  .max(44)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/);

export const VerifiedEntityAddressSchema = z
  .object({
    address: SolanaAddressSchema,
    entityType: z.enum(["EXCHANGE", "BRIDGE", "PROTOCOL", "CONTRACT", "POOL"]),
    label: z.string().min(1).max(128),
    source: z.string().min(1).max(100),
    sourceUrl: z.url().max(2048),
    evidenceHash: Sha256Schema,
    validFrom: IsoTimestampSchema,
    validTo: IsoTimestampSchema.optional(),
    retrievedAt: IsoTimestampSchema,
    schemaVersion: z.literal("1"),
  })
  .strict()
  .refine((value) => value.validTo === undefined || value.validFrom <= value.validTo, {
    message: "validFrom must not follow validTo",
  });

export type VerifiedEntityAddress = z.infer<typeof VerifiedEntityAddressSchema>;

export const VerifiedEntityRegistryFileSchema = z
  .object({
    registryVersion: z.string().regex(/^[1-9][0-9]*$/),
    generatedAt: IsoTimestampSchema,
    records: z.array(VerifiedEntityAddressSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const identities = new Set<string>();
    value.records.forEach((record, index) => {
      const identity = `${record.address}:${record.validFrom}`;
      if (identities.has(identity))
        context.addIssue({
          code: "custom",
          path: ["records", index],
          message: "duplicate address validity identity",
        });
      identities.add(identity);
    });
  });

export type VerifiedEntityRegistryFile = z.infer<typeof VerifiedEntityRegistryFileSchema>;

export interface PointInTimeAttributionResolution {
  readonly status: "RESOLVED" | "CONFLICT" | "UNKNOWN";
  readonly asOf: string;
  readonly selected: VerifiedEntityAddress | null;
  readonly applicableClaims: readonly VerifiedEntityAddress[];
  readonly conflictingClaims: readonly VerifiedEntityAddress[];
}

export function resolvePointInTimeAttribution(
  claims: readonly VerifiedEntityAddress[],
  address: string,
  asOf: string,
): PointInTimeAttributionResolution {
  SolanaAddressSchema.parse(address);
  IsoTimestampSchema.parse(asOf);
  const applicableClaims = claims
    .map((claim) => VerifiedEntityAddressSchema.parse(claim))
    .filter(
      (claim) =>
        claim.address === address &&
        claim.retrievedAt <= asOf &&
        claim.validFrom <= asOf &&
        (claim.validTo === undefined || claim.validTo >= asOf),
    )
    .sort(
      (left, right) =>
        right.validFrom.localeCompare(left.validFrom) ||
        left.entityType.localeCompare(right.entityType) ||
        left.label.localeCompare(right.label) ||
        left.evidenceHash.localeCompare(right.evidenceHash),
    );
  const selected = applicableClaims.at(0) ?? null;
  if (!selected)
    return { status: "UNKNOWN", asOf, selected: null, applicableClaims, conflictingClaims: [] };
  const conflictingClaims = applicableClaims.filter(
    (claim) => claim.entityType !== selected.entityType || claim.label !== selected.label,
  );
  return {
    status: conflictingClaims.length === 0 ? "RESOLVED" : "CONFLICT",
    asOf,
    selected,
    applicableClaims,
    conflictingClaims,
  };
}
