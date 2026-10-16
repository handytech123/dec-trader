import { z } from "zod";
import { DomainIdSchema, IsoTimestampSchema, Sha256Schema } from "@autonomous-trading-lab/domain";

const VersionSchema = z.string().regex(/^[1-9][0-9]*$/);
const NonNegativeDecimalSchema = z
  .string()
  // Canonical decimal input is bounded by the enclosing contracts.
  // eslint-disable-next-line security/detect-unsafe-regex
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);

export const EvidenceReferenceSchema = z
  .object({
    source: z.string().min(1).max(100),
    rawRef: Sha256Schema,
    observedAt: IsoTimestampSchema,
    method: z.enum(["VERIFIED", "PROVIDER_LABEL", "HEURISTIC"]),
  })
  .strict();
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

export const ProvenanceSchema = z
  .object({
    sourceProvider: z.string().min(1).max(100),
    sourceType: z.enum(["CHAIN", "MARKET", "ENTITY_INTEL", "RESEARCH", "FIXTURE"]),
    sourceId: z.string().min(1).max(256),
    observedAt: IsoTimestampSchema,
    ingestedAt: IsoTimestampSchema,
    rawObjectRef: Sha256Schema,
    schemaVersion: VersionSchema,
    parserVersion: VersionSchema,
    confidence: z.number().min(0).max(1).optional(),
    licenseTag: z.string().min(1).max(100).optional(),
  })
  .strict();
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const EnrichmentClaimSchema = z
  .object({
    claimId: DomainIdSchema,
    subjectId: DomainIdSchema,
    claimType: z.string().min(1).max(100),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    provider: z.string().min(1).max(100),
    confidence: z.number().min(0).max(1),
    evidenceRefs: z.array(Sha256Schema).min(1),
    validFrom: IsoTimestampSchema.optional(),
    validTo: IsoTimestampSchema.optional(),
    retrievedAt: IsoTimestampSchema,
    schemaVersion: VersionSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.validFrom === undefined ||
      value.validTo === undefined ||
      value.validFrom <= value.validTo,
    { message: "validFrom must not follow validTo" },
  );
export type EnrichmentClaim = z.infer<typeof EnrichmentClaimSchema>;

export const EntitySchema = z
  .object({
    entityId: DomainIdSchema,
    entityType: z.enum([
      "ADDRESS",
      "CLUSTER",
      "EXCHANGE",
      "BRIDGE",
      "PROTOCOL",
      "CONTRACT",
      "POOL",
    ]),
    labels: z.array(z.string().min(1).max(128)),
    addresses: z.array(z.string().min(1).max(256)),
    attribution: z.enum(["VERIFIED", "HEURISTIC", "UNKNOWN"]),
    confidence: z.number().min(0).max(1),
    firstSeen: IsoTimestampSchema,
    lastSeen: IsoTimestampSchema,
    evidence: z.array(EvidenceReferenceSchema),
    schemaVersion: VersionSchema,
  })
  .strict()
  .refine((value) => value.firstSeen <= value.lastSeen, {
    message: "firstSeen must not follow lastSeen",
  })
  .superRefine((value, context) => {
    if (
      value.attribution === "VERIFIED" &&
      value.evidence.every((item) => item.method !== "VERIFIED")
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "verified attribution requires verified evidence",
      });
    }
  });
export type Entity = z.infer<typeof EntitySchema>;

export const EntityRelationshipSchema = z
  .object({
    relationshipId: DomainIdSchema,
    fromEntityId: DomainIdSchema,
    toEntityId: DomainIdSchema,
    relationshipType: z.enum([
      "CONTROLS",
      "DEPOSITED_TO",
      "WITHDREW_FROM",
      "BRIDGED_TO",
      "SWAPPED_IN",
      "INTERACTED_WITH",
      "HEURISTICALLY_CLUSTERED_WITH",
    ]),
    firstSeen: IsoTimestampSchema,
    lastSeen: IsoTimestampSchema,
    eventCount: z.number().int().positive(),
    usdValue: NonNegativeDecimalSchema,
    confidence: z.number().min(0).max(1),
    evidenceRefs: z.array(Sha256Schema).min(1),
    schemaVersion: VersionSchema,
  })
  .strict()
  .refine((value) => value.fromEntityId !== value.toEntityId, {
    message: "a relationship cannot point to the same entity",
  });
export type EntityRelationship = z.infer<typeof EntityRelationshipSchema>;

export const CapitalEventSchema = z
  .object({
    eventId: DomainIdSchema,
    eventTime: IsoTimestampSchema,
    ingestTime: IsoTimestampSchema,
    source: z.string().min(1).max(100),
    chain: z.string().min(1).max(50),
    venue: z.string().min(1).max(100).optional(),
    eventType: z.enum(["TRANSFER", "SWAP", "BRIDGE", "LIQUIDITY_ADD", "LIQUIDITY_REMOVE"]),
    assetId: DomainIdSchema,
    quantity: NonNegativeDecimalSchema,
    usdValueAtEvent: NonNegativeDecimalSchema.nullable(),
    fromEntityId: DomainIdSchema.optional(),
    toEntityId: DomainIdSchema.optional(),
    transactionHash: z.string().min(1).max(256).optional(),
    confidence: z.number().min(0).max(1),
    rawRef: Sha256Schema,
    schemaVersion: VersionSchema,
  })
  .strict()
  .refine((value) => value.fromEntityId !== undefined || value.toEntityId !== undefined, {
    message: "a capital event requires at least one entity endpoint",
  });
export type CapitalEvent = z.infer<typeof CapitalEventSchema>;

export const MarketEventSchema = z
  .object({
    eventId: DomainIdSchema,
    eventTime: IsoTimestampSchema,
    ingestTime: IsoTimestampSchema,
    source: z.string().min(1).max(100),
    venue: z.string().min(1).max(100),
    instrumentId: DomainIdSchema,
    eventType: z.enum(["TRADE", "QUOTE", "BOOK_DELTA", "FUNDING", "OPEN_INTEREST", "LIQUIDATION"]),
    price: NonNegativeDecimalSchema.optional(),
    quantity: NonNegativeDecimalSchema.optional(),
    side: z.enum(["BUY", "SELL"]).optional(),
    bid: NonNegativeDecimalSchema.optional(),
    ask: NonNegativeDecimalSchema.optional(),
    bookSequence: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .optional(),
    rawRef: Sha256Schema,
    schemaVersion: VersionSchema,
  })
  .strict();
export type MarketEvent = z.infer<typeof MarketEventSchema>;
