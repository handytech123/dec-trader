import { z } from "zod";
import {
  AtomicQuantitySchema,
  DomainIdSchema,
  IsoTimestampSchema,
  Sha256Schema,
} from "@autonomous-trading-lab/domain";

export const QuoteRequestSchema = z
  .object({
    proposalId: DomainIdSchema,
    proposalHash: Sha256Schema,
    inputMint: z.string().min(32).max(44),
    outputMint: z.string().min(32).max(44),
    requestedInputAtomic: AtomicQuantitySchema,
    validUntil: IsoTimestampSchema,
  })
  .strict();
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;

export const NormalizedQuoteSchema = z
  .object({
    quoteId: DomainIdSchema,
    proposalHash: Sha256Schema,
    quoteHash: Sha256Schema,
    inputAtomic: AtomicQuantitySchema,
    expectedOutputAtomic: AtomicQuantitySchema,
    minimumOutputAtomic: AtomicQuantitySchema,
    priceImpactBps: z.number().int().nonnegative(),
    estimatedTotalCostBps: z.number().int().nonnegative(),
    routeProgramLabels: z.array(z.string().min(1)).min(1),
    expiresAt: IsoTimestampSchema,
    provider: z.string().min(1),
    providerPayloadHash: Sha256Schema,
  })
  .strict();
export type NormalizedQuote = z.infer<typeof NormalizedQuoteSchema>;

export const RiskCheckSchema = z
  .object({
    ruleId: z.string().min(1),
    ruleVersion: z.string().min(1),
    outcome: z.enum(["PASS", "FAIL"]),
    actual: z.string(),
    threshold: z.string(),
  })
  .strict();

export const RiskPrecheckSchema = z
  .object({
    decisionId: DomainIdSchema,
    proposalHash: Sha256Schema,
    quoteHash: Sha256Schema,
    outcome: z.enum(["ELIGIBLE_FOR_BUILD", "REJECTED"]),
    checks: z.array(RiskCheckSchema).min(1),
    decidedAt: IsoTimestampSchema,
  })
  .strict();
export type RiskPrecheck = z.infer<typeof RiskPrecheckSchema>;

export const ExecutionAuthorizationSchema = z
  .object({
    authorizationId: DomainIdSchema,
    proposalHash: Sha256Schema,
    quoteHash: Sha256Schema,
    inspectedSwapHash: Sha256Schema,
    simulationHash: Sha256Schema,
    riskProfileVersionId: DomainIdSchema,
    walletPolicyId: DomainIdSchema,
    network: z.literal("solana-mainnet"),
    maximumInputAtomic: AtomicQuantitySchema,
    minimumOutputAtomic: AtomicQuantitySchema,
    issuedAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
    nonce: z.string().min(16).max(256),
  })
  .strict();
export type ExecutionAuthorization = z.infer<typeof ExecutionAuthorizationSchema>;

export const ExecutionStateSchema = z.enum([
  "PROPOSED",
  "QUOTED",
  "RISK_PRECHECKED",
  "BUILT",
  "VALIDATED",
  "SIMULATED",
  "AUTHORIZED",
  "SIGNED",
  "SUBMITTED",
  "CONFIRMED",
  "RECONCILED",
  "REJECTED",
  "EXPIRED",
  "SIMULATION_FAILED",
  "SUBMISSION_FAILED",
  "ONCHAIN_FAILED",
  "UNKNOWN",
  "CANCELLED",
]);
export type ExecutionState = z.infer<typeof ExecutionStateSchema>;

const transitions: Readonly<Record<ExecutionState, readonly ExecutionState[]>> = {
  PROPOSED: ["QUOTED", "REJECTED", "EXPIRED", "CANCELLED"],
  QUOTED: ["RISK_PRECHECKED", "REJECTED", "EXPIRED", "CANCELLED"],
  RISK_PRECHECKED: ["BUILT", "REJECTED", "EXPIRED", "CANCELLED"],
  BUILT: ["VALIDATED", "REJECTED", "EXPIRED", "CANCELLED"],
  VALIDATED: ["SIMULATED", "SIMULATION_FAILED", "REJECTED", "EXPIRED"],
  SIMULATED: ["AUTHORIZED", "REJECTED", "EXPIRED"],
  AUTHORIZED: ["SIGNED", "REJECTED", "EXPIRED"],
  SIGNED: ["SUBMITTED", "SUBMISSION_FAILED", "UNKNOWN"],
  SUBMITTED: ["CONFIRMED", "ONCHAIN_FAILED", "UNKNOWN"],
  CONFIRMED: ["RECONCILED", "UNKNOWN"],
  UNKNOWN: ["CONFIRMED", "ONCHAIN_FAILED", "RECONCILED"],
  RECONCILED: [],
  REJECTED: [],
  EXPIRED: [],
  SIMULATION_FAILED: [],
  SUBMISSION_FAILED: [],
  ONCHAIN_FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: ExecutionState, to: ExecutionState): boolean {
  // Both keys are closed enum values validated by the type/runtime schema.
  // eslint-disable-next-line security/detect-object-injection
  return transitions[from].includes(to);
}
