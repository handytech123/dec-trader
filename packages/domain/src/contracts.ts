import { z } from "zod";
import { DomainIdSchema, IsoTimestampSchema, Sha256Schema } from "./identifiers.js";
import { EvaluationModeSchema } from "./modes.js";
import { AtomicQuantitySchema } from "./quantities.js";

const MintSchema = z
  .string()
  .min(32)
  .max(44)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
const SignalValueSchema = z.union([z.number(), z.string(), z.boolean(), z.null()]);

export const StrategyContextSchema = z
  .object({
    evaluationId: DomainIdSchema,
    evaluatedAt: IsoTimestampSchema,
    asOfSlot: AtomicQuantitySchema.optional(),
    mode: EvaluationModeSchema,
    portfolioSnapshotId: DomainIdSchema,
    featureSnapshotId: DomainIdSchema,
  })
  .strict();
export type StrategyContext = z.infer<typeof StrategyContextSchema>;

export const TradeProposalSchema = z
  .object({
    proposalId: DomainIdSchema,
    strategyVersionId: DomainIdSchema,
    experimentId: DomainIdSchema,
    side: z.enum(["BUY", "SELL"]),
    inputMint: MintSchema,
    outputMint: MintSchema,
    requestedInputAtomic: AtomicQuantitySchema,
    thesisCode: z.string().min(1).max(128),
    signalValues: z.record(z.string(), SignalValueSchema),
    confidence: z.number().min(0).max(1).optional(),
    validUntil: IsoTimestampSchema,
  })
  .strict();
export type TradeProposal = z.infer<typeof TradeProposalSchema>;

export const DomainEventEnvelopeSchema = z
  .object({
    eventId: DomainIdSchema,
    eventType: z.enum([
      "ObservationAccepted",
      "FeatureSnapshotPublished",
      "StrategyEvaluated",
      "TradeProposed",
      "RiskDecisionRecorded",
      "OrderStateChanged",
      "TransactionObserved",
      "PositionReconciled",
      "CircuitBreakerTripped",
      "SystemModeChanged",
    ]),
    occurredAt: IsoTimestampSchema,
    correlationId: DomainIdSchema,
    idempotencyKey: z.string().min(16).max(256),
    schemaVersion: z.string().regex(/^[1-9][0-9]*$/),
    producer: z.string().min(1).max(100),
    commitSha: Sha256Schema,
    actorId: DomainIdSchema.optional(),
    payloadHash: Sha256Schema,
  })
  .strict();
export type DomainEventEnvelope = z.infer<typeof DomainEventEnvelopeSchema>;

export const EnvironmentConfigSchema = z
  .object({
    ATL_ENVIRONMENT: z.enum(["development", "paper", "live"]),
    ATL_SYSTEM_MODE: z.enum(["OFFLINE_RESEARCH", "SHADOW", "PAPER", "LIVE_ARMED", "HALTED"]),
    ATL_NETWORK_ACCESS: z.literal("disabled"),
    ATL_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.ATL_ENVIRONMENT === "live" || config.ATL_SYSTEM_MODE === "LIVE_ARMED") {
      context.addIssue({
        code: "custom",
        message: "live environment and mode are unavailable in Phase 0",
      });
    }
  });
export type EnvironmentConfig = z.infer<typeof EnvironmentConfigSchema>;
