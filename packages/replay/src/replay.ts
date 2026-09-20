import {
  contentHash,
  TradeProposalSchema,
  type TradeProposal,
} from "@autonomous-trading-lab/domain";
import {
  MarketObservationSchema,
  pointInTimeObservations,
  type Experiment,
  type MarketObservation,
  type StrategyVersion,
} from "@autonomous-trading-lab/data-foundation";

export interface ReplayInput {
  readonly experiment: Experiment;
  readonly strategyVersion: StrategyVersion;
  readonly observations: readonly MarketObservation[];
}

export interface ReplayContext {
  readonly experiment: Experiment;
  readonly strategyVersion: StrategyVersion;
  readonly observations: readonly MarketObservation[];
  readonly inputHash: `sha256:${string}`;
}

export type ReplayEvaluator = (context: ReplayContext) => readonly TradeProposal[];

export interface ReplayResult {
  readonly inputHash: `sha256:${string}`;
  readonly proposalHash: `sha256:${string}`;
  readonly replayHash: `sha256:${string}`;
  readonly proposals: readonly TradeProposal[];
  readonly observationCount: number;
}

function sortObservations(
  observations: readonly MarketObservation[],
): readonly MarketObservation[] {
  return observations
    .map((observation) => MarketObservationSchema.parse(observation))
    .sort((left, right) =>
      [left.sourceTime, left.source, left.observationId]
        .join("\u0000")
        .localeCompare([right.sourceTime, right.source, right.observationId].join("\u0000")),
    );
}

export function replay(input: ReplayInput, evaluate: ReplayEvaluator): ReplayResult {
  if (input.experiment.strategyVersionId !== input.strategyVersion.strategyVersionId) {
    throw new Error("experiment and strategy version do not match");
  }
  const bounded = pointInTimeObservations(
    sortObservations(input.observations),
    input.experiment.datasetEnd,
  ).filter((observation) => observation.sourceTime >= input.experiment.datasetStart);
  const inputIdentity = {
    experimentHash: input.experiment.contentHash,
    strategyVersionHash: input.strategyVersion.contentHash,
    observationHashes: bounded.map((observation) => contentHash(observation)),
    seed: input.experiment.seed,
  };
  const inputHash = contentHash(inputIdentity);
  const context: ReplayContext = Object.freeze({
    experiment: structuredClone(input.experiment),
    strategyVersion: structuredClone(input.strategyVersion),
    observations: Object.freeze(
      bounded.map((observation) => Object.freeze(structuredClone(observation))),
    ),
    inputHash,
  });
  const proposals = evaluate(context)
    .map((proposal) => TradeProposalSchema.parse(proposal))
    .sort((left, right) => left.proposalId.localeCompare(right.proposalId));
  const proposalHash = contentHash(proposals);
  return {
    inputHash,
    proposalHash,
    replayHash: contentHash({ inputHash, proposalHash }),
    proposals,
    observationCount: bounded.length,
  };
}
