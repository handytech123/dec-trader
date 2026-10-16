import {
  StrategyContextSchema,
  TradeProposalSchema,
  contentHash,
  type Sha256,
  type StrategyContext,
  type TradeProposal,
} from "@autonomous-trading-lab/domain";
import type { ReadonlyFeatureSnapshot, StrategyModule } from "./index.js";

export type ProposalDecision = "PROPOSE" | "NO_TRADE";

export interface StrategyProposalEvaluation {
  readonly authority: "PAPER_PROPOSAL_ONLY";
  readonly evaluationId: string;
  readonly strategyVersionId: string;
  readonly evaluatedAt: string;
  readonly decision: ProposalDecision;
  readonly reasons: readonly string[];
  readonly inputHash: Sha256;
  readonly proposals: readonly TradeProposal[];
  readonly proposalHashes: readonly Sha256[];
}

export interface StrategyProposalRunnerInput {
  readonly strategyVersionId: string;
  readonly context: StrategyContext;
  readonly features: ReadonlyFeatureSnapshot;
}

function validateProposal(
  proposal: TradeProposal,
  input: StrategyProposalRunnerInput,
): TradeProposal {
  const parsed = TradeProposalSchema.parse(proposal);
  if (parsed.strategyVersionId !== input.strategyVersionId)
    throw new Error("proposal strategy version does not match the evaluated strategy");
  if (parsed.inputMint === parsed.outputMint)
    throw new Error("proposal input and output mints must differ");
  if (BigInt(parsed.requestedInputAtomic) <= 0n)
    throw new Error("proposal requested input must be positive");
  if (Date.parse(parsed.validUntil) <= Date.parse(input.context.evaluatedAt))
    throw new Error("proposal must expire after its evaluation time");
  return parsed;
}

/**
 * Runs one pure strategy behind a fail-closed, paper-only boundary. This component has no network,
 * database, wallet, quote-provider, signing, submission, or capital-allocation capability.
 */
export async function runStrategyProposalEvaluation(
  module: StrategyModule,
  input: StrategyProposalRunnerInput,
): Promise<StrategyProposalEvaluation> {
  const context = StrategyContextSchema.parse(input.context);
  if (context.mode === "LIVE") throw new Error("live strategy evaluation is unavailable");
  if (!input.strategyVersionId) throw new Error("strategy version is required");

  const normalizedInput = {
    strategyVersionId: input.strategyVersionId,
    context,
    features: input.features,
  };
  const inputHash = contentHash(normalizedInput);
  const emitted = await module.evaluate({ context, features: input.features });
  const proposals = emitted
    .map((proposal) => validateProposal(proposal, normalizedInput))
    .sort((left, right) => left.proposalId.localeCompare(right.proposalId));
  if (new Set(proposals.map((proposal) => proposal.proposalId)).size !== proposals.length)
    throw new Error("strategy emitted duplicate proposal IDs");

  return {
    authority: "PAPER_PROPOSAL_ONLY",
    evaluationId: context.evaluationId,
    strategyVersionId: input.strategyVersionId,
    evaluatedAt: context.evaluatedAt,
    decision: proposals.length > 0 ? "PROPOSE" : "NO_TRADE",
    reasons: proposals.length > 0 ? ["STRATEGY_CRITERIA_SATISFIED"] : ["NO_ELIGIBLE_SIGNAL"],
    inputHash,
    proposals,
    proposalHashes: proposals.map((proposal) => contentHash(proposal)),
  };
}
