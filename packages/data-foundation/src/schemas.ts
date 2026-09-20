import { z } from "zod";
import {
  DecimalSchema,
  DomainIdSchema,
  IsoTimestampSchema,
  Sha256Schema,
} from "@autonomous-trading-lab/domain";

const SlotSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const VersionSchema = z.string().regex(/^[1-9][0-9]*$/);
const FeatureValueSchema = z.union([DecimalSchema, z.string(), z.boolean(), z.null()]);

export const RawObservationSchema = z
  .object({
    observationId: DomainIdSchema,
    ingestionId: DomainIdSchema,
    source: z.string().min(1).max(100),
    sourceId: z.string().min(1).max(256),
    observedAt: IsoTimestampSchema,
    sourceTime: IsoTimestampSchema,
    slot: SlotSchema.optional(),
    schemaVersion: VersionSchema,
    payload: z.unknown(),
    payloadHash: Sha256Schema,
  })
  .strict();
export type RawObservation = z.infer<typeof RawObservationSchema>;

export const MarketObservationSchema = z
  .object({
    observationId: DomainIdSchema,
    rawObservationHash: Sha256Schema,
    assetId: DomainIdSchema,
    poolId: DomainIdSchema.optional(),
    price: DecimalSchema,
    volume: DecimalSchema,
    liquidity: DecimalSchema,
    observedAt: IsoTimestampSchema,
    sourceTime: IsoTimestampSchema,
    slot: SlotSchema.optional(),
    source: z.string().min(1),
    schemaVersion: VersionSchema,
  })
  .strict();
export type MarketObservation = z.infer<typeof MarketObservationSchema>;

export const FeatureDefinitionSchema = z
  .object({
    featureDefinitionId: DomainIdSchema,
    name: z.string().min(1).max(100),
    version: VersionSchema,
    units: z.string().min(1).max(50),
    window: z.string().min(1).max(100),
    sources: z.array(z.string().min(1)).min(1),
    nullBehavior: z.enum(["REJECT", "NULL", "ZERO"]),
    freshnessLimitSeconds: z.number().int().positive(),
    codeHash: Sha256Schema,
    configHash: Sha256Schema,
    contentHash: Sha256Schema,
    publishedAt: IsoTimestampSchema,
  })
  .strict();
export type FeatureDefinition = z.infer<typeof FeatureDefinitionSchema>;

export const FeatureSnapshotSchema = z
  .object({
    featureSnapshotId: DomainIdSchema,
    asOf: IsoTimestampSchema,
    asOfSlot: SlotSchema.optional(),
    definitionHashes: z.array(Sha256Schema).min(1),
    observationHashes: z.array(Sha256Schema),
    values: z.record(z.string(), FeatureValueSchema),
    contentHash: Sha256Schema,
  })
  .strict();
export type FeatureSnapshot = z.infer<typeof FeatureSnapshotSchema>;

export const StrategyVersionSchema = z
  .object({
    strategyVersionId: DomainIdSchema,
    strategyDefinitionId: DomainIdSchema,
    version: VersionSchema,
    sourceHash: Sha256Schema,
    configHash: Sha256Schema,
    featureSchemaHash: Sha256Schema,
    modelArtifactHash: Sha256Schema.optional(),
    contentHash: Sha256Schema,
    eligibility: z.enum(["INACTIVE", "RESEARCH", "SUSPENDED"]),
    publishedAt: IsoTimestampSchema,
  })
  .strict();
export type StrategyVersion = z.infer<typeof StrategyVersionSchema>;

export const ExperimentSchema = z
  .object({
    experimentId: DomainIdSchema,
    hypothesis: z.string().min(1),
    strategyVersionId: DomainIdSchema,
    datasetStart: IsoTimestampSchema,
    datasetEnd: IsoTimestampSchema,
    mode: z.literal("BACKTEST"),
    seed: z.string().regex(/^(0|[1-9][0-9]*)$/),
    status: z.enum(["REGISTERED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]),
    contentHash: Sha256Schema,
    registeredAt: IsoTimestampSchema,
  })
  .strict()
  .refine((value) => value.datasetStart < value.datasetEnd, {
    message: "datasetStart must precede datasetEnd",
  });
export type Experiment = z.infer<typeof ExperimentSchema>;
