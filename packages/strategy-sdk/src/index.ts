import type { StrategyContext, TradeProposal } from "@autonomous-trading-lab/domain";

export * from "./style-selector.js";
export * from "./reference-style-library.js";
export * from "./proposal-runner.js";
export * from "./cfie-response-failure.js";
export * from "./cfie-flow-strategies.js";
export * from "./cfie-market-strategies.js";

export type ReadonlyFeatureSnapshot = Readonly<Record<string, number | string | boolean | null>>;

export interface StrategyInput {
  readonly context: Readonly<StrategyContext>;
  readonly features: ReadonlyFeatureSnapshot;
}

/** A pure decision boundary: no signer, provider, wallet, or network capability is exposed. */
export interface StrategyModule {
  evaluate(input: StrategyInput): readonly TradeProposal[] | Promise<readonly TradeProposal[]>;
}
