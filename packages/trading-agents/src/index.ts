import { contentHash, type Sha256, type TradeProposal } from "@autonomous-trading-lab/domain";
import {
  applyPaperFill,
  evaluatePaperRisk,
  simulatePaperFill,
  type PaperFill,
  type PaperFillModel,
  type PaperOrder,
  type PaperPortfolio,
  type PaperRiskLimits,
  type PaperRiskSnapshot,
} from "@autonomous-trading-lab/backtest";

export interface FalsificationEvidence {
  readonly sampleSize: number;
  readonly holdoutExpectancyBps: number;
  readonly randomizedBaselineBps: number;
  readonly stressedCostBps: number;
  readonly outlierRemovedExpectancyBps: number;
  readonly replayReproducibility: number;
  readonly pointInTimeVerified: boolean;
}

export interface FalsificationVerdict {
  readonly authority: "VETO_ONLY";
  readonly outcome: "SURVIVES" | "REJECTED";
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
  readonly evidenceHash: Sha256;
}

/** May veto a proposal; it cannot approve risk, allocate capital, or execute. */
export function falsifyProposal(
  proposal: TradeProposal,
  evidence: FalsificationEvidence,
): FalsificationVerdict {
  const checks = [
    { name: "POINT_IN_TIME", passed: evidence.pointInTimeVerified },
    { name: "MINIMUM_SAMPLE", passed: evidence.sampleSize >= 100 },
    { name: "POSITIVE_HOLDOUT", passed: evidence.holdoutExpectancyBps > 0 },
    {
      name: "BEATS_RANDOMIZED_BASELINE",
      passed: evidence.holdoutExpectancyBps > evidence.randomizedBaselineBps,
    },
    {
      name: "SURVIVES_STRESSED_COSTS",
      passed: evidence.holdoutExpectancyBps > evidence.stressedCostBps,
    },
    { name: "SURVIVES_OUTLIERS", passed: evidence.outlierRemovedExpectancyBps > 0 },
    { name: "REPLAY_REPRODUCIBLE", passed: evidence.replayReproducibility >= 0.95 },
  ];
  return {
    authority: "VETO_ONLY",
    outcome: checks.every((check) => check.passed) ? "SURVIVES" : "REJECTED",
    checks,
    evidenceHash: contentHash({ proposal, evidence }),
  };
}

export interface PortfolioCandidate {
  readonly proposal: TradeProposal;
  readonly falsification: FalsificationVerdict;
  readonly expectedNetBps: number;
  readonly correlationGroup: string;
  readonly requestedNotionalUsd: number;
}

export interface PortfolioDecision {
  readonly authority: "PAPER_ALLOCATION_ONLY";
  readonly selected: readonly PortfolioCandidate[];
  readonly rejectedProposalIds: readonly string[];
  readonly totalNotionalUsd: number;
  readonly decisionHash: Sha256;
}

/** Selects at most one surviving proposal per correlation group under a paper budget. */
export function allocatePaperPortfolio(
  candidates: readonly PortfolioCandidate[],
  maximumGrossNotionalUsd: number,
): PortfolioDecision {
  if (!Number.isFinite(maximumGrossNotionalUsd) || maximumGrossNotionalUsd < 0)
    throw new Error("paper portfolio budget must be non-negative");
  const selected: PortfolioCandidate[] = [];
  const groups = new Set<string>();
  let total = 0;
  for (const candidate of [...candidates].sort(
    (left, right) =>
      right.expectedNetBps - left.expectedNetBps ||
      left.proposal.proposalId.localeCompare(right.proposal.proposalId),
  )) {
    if (
      candidate.falsification.outcome !== "SURVIVES" ||
      candidate.expectedNetBps <= 0 ||
      groups.has(candidate.correlationGroup) ||
      total + candidate.requestedNotionalUsd > maximumGrossNotionalUsd
    )
      continue;
    selected.push(candidate);
    groups.add(candidate.correlationGroup);
    total += candidate.requestedNotionalUsd;
  }
  const selectedIds = new Set(selected.map((candidate) => candidate.proposal.proposalId));
  const body = {
    authority: "PAPER_ALLOCATION_ONLY" as const,
    selected,
    rejectedProposalIds: candidates
      .filter((candidate) => !selectedIds.has(candidate.proposal.proposalId))
      .map((candidate) => candidate.proposal.proposalId)
      .sort(),
    totalNotionalUsd: total,
  };
  return { ...body, decisionHash: contentHash(body) };
}

export function paperRiskGate(input: {
  readonly limits: PaperRiskLimits;
  readonly snapshot: PaperRiskSnapshot;
  readonly proposal: PortfolioCandidate;
}) {
  return evaluatePaperRisk({
    limits: input.limits,
    snapshot: input.snapshot,
    intent: {
      intentId: input.proposal.proposal.proposalId,
      styleId: input.proposal.proposal.strategyVersionId,
      tradeNotionalUsd: input.proposal.requestedNotionalUsd,
    },
  });
}

export interface PaperExecutionResult {
  readonly authority: "SIMULATION_ONLY";
  readonly fill: PaperFill;
  readonly resultHash: Sha256;
}

export function executePaperOrder(order: PaperOrder, model: PaperFillModel): PaperExecutionResult {
  const fill = simulatePaperFill(order, model);
  return { authority: "SIMULATION_ONLY", fill, resultHash: contentHash({ order, model, fill }) };
}

export function reconcilePaperExecution(input: {
  readonly portfolio: PaperPortfolio;
  readonly inputAsset: string;
  readonly outputAsset: string;
  readonly execution: PaperExecutionResult;
}) {
  return applyPaperFill({
    portfolio: input.portfolio,
    inputAsset: input.inputAsset,
    outputAsset: input.outputAsset,
    fill: input.execution.fill,
  });
}

export interface SupervisorDecision {
  readonly mode: "PAPER_ONLY";
  readonly outcome: "CONTINUE" | "HALT";
  readonly reasons: readonly string[];
}

/** Independent control plane. Any failed invariant halts the paper chain. */
export function supervisePaperPipeline(input: {
  readonly collectorsHealthy: boolean;
  readonly dataFresh: boolean;
  readonly accountingReconciled: boolean;
  readonly failureCount: number;
  readonly maximumFailures: number;
}): SupervisorDecision {
  const reasons = [
    ...(input.collectorsHealthy ? [] : ["COLLECTOR_UNHEALTHY"]),
    ...(input.dataFresh ? [] : ["STALE_DATA"]),
    ...(input.accountingReconciled ? [] : ["ACCOUNTING_UNRECONCILED"]),
    ...(input.failureCount <= input.maximumFailures ? [] : ["FAILURE_LIMIT_EXCEEDED"]),
  ];
  return { mode: "PAPER_ONLY", outcome: reasons.length === 0 ? "CONTINUE" : "HALT", reasons };
}

export interface PaperAgentPipelineInput {
  readonly candidate: PortfolioCandidate;
  readonly evidence: FalsificationEvidence;
  readonly portfolioBudgetUsd: number;
  readonly riskLimits: PaperRiskLimits;
  readonly riskSnapshot: PaperRiskSnapshot;
  readonly order: PaperOrder;
  readonly fillModel: PaperFillModel;
  readonly portfolio: PaperPortfolio;
  readonly supervisor: Parameters<typeof supervisePaperPipeline>[0];
}

export interface PaperAgentPipelineResult {
  readonly authority: "PAPER_ONLY_NO_EXECUTION";
  readonly outcome: "HALTED" | "REJECTED" | "SIMULATED_AND_RECONCILED";
  readonly stoppedAt:
    | "SUPERVISOR"
    | "FALSIFICATION"
    | "PORTFOLIO"
    | "RISK"
    | "EXECUTION"
    | "RECONCILIATION";
  readonly trace: Readonly<Record<string, unknown>>;
  readonly traceHash: Sha256;
}

/** Runs the full chain while preserving each independent veto boundary. */
export function runPaperAgentPipeline(input: PaperAgentPipelineInput): PaperAgentPipelineResult {
  const supervisor = supervisePaperPipeline(input.supervisor);
  const finish = (
    outcome: PaperAgentPipelineResult["outcome"],
    stoppedAt: PaperAgentPipelineResult["stoppedAt"],
    trace: Readonly<Record<string, unknown>>,
  ): PaperAgentPipelineResult => ({
    authority: "PAPER_ONLY_NO_EXECUTION",
    outcome,
    stoppedAt,
    trace,
    traceHash: contentHash(trace),
  });
  if (supervisor.outcome === "HALT") return finish("HALTED", "SUPERVISOR", { supervisor });

  const falsification = falsifyProposal(input.candidate.proposal, input.evidence);
  if (falsification.outcome === "REJECTED")
    return finish("REJECTED", "FALSIFICATION", { supervisor, falsification });

  const candidate = { ...input.candidate, falsification };
  const portfolioDecision = allocatePaperPortfolio([candidate], input.portfolioBudgetUsd);
  if (portfolioDecision.selected.length === 0)
    return finish("REJECTED", "PORTFOLIO", { supervisor, falsification, portfolioDecision });

  const risk = paperRiskGate({
    limits: input.riskLimits,
    snapshot: input.riskSnapshot,
    proposal: candidate,
  });
  if (risk.outcome === "REJECTED")
    return finish("REJECTED", "RISK", {
      supervisor,
      falsification,
      portfolioDecision,
      risk,
    });

  const execution = executePaperOrder(input.order, input.fillModel);
  if (execution.fill.status === "REJECTED")
    return finish("REJECTED", "EXECUTION", {
      supervisor,
      falsification,
      portfolioDecision,
      risk,
      execution,
    });
  const reconciliation = reconcilePaperExecution({
    portfolio: input.portfolio,
    inputAsset: input.candidate.proposal.inputMint,
    outputAsset: input.candidate.proposal.outputMint,
    execution,
  });
  if (reconciliation.status !== "APPLIED")
    return finish("HALTED", "RECONCILIATION", {
      supervisor,
      falsification,
      portfolioDecision,
      risk,
      execution,
      reconciliation,
    });
  return finish("SIMULATED_AND_RECONCILED", "RECONCILIATION", {
    supervisor,
    falsification,
    portfolioDecision,
    risk,
    execution,
    reconciliation,
  });
}
