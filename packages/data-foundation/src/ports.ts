import type {
  Experiment,
  FeatureSnapshot,
  MarketObservation,
  RawObservation,
  StrategyVersion,
} from "./schemas.js";

export interface ObservationRepository {
  appendRaw(observation: RawObservation): Promise<{ accepted: boolean }>;
  publishNormalized(observation: MarketObservation): Promise<void>;
  listAsOf(asOf: string, asOfSlot?: string): Promise<readonly MarketObservation[]>;
}

export interface ResearchRegistryRepository {
  publishStrategyVersion(version: StrategyVersion): Promise<void>;
  registerExperiment(experiment: Experiment): Promise<void>;
  publishFeatureSnapshot(snapshot: FeatureSnapshot): Promise<void>;
}
