import type { StrategyContext, TradeProposal } from "@autonomous-trading-lab/domain";

export type ReadonlyFeatureSnapshot = Readonly<Record<string, number | string | boolean | null>>;

export interface StrategyInput {
  readonly context: Readonly<StrategyContext>;
  readonly features: ReadonlyFeatureSnapshot;
}

/** A pure decision boundary: no signer, provider, wallet, or network capability is exposed. */
export interface StrategyModule {
  evaluate(input: StrategyInput): readonly TradeProposal[] | Promise<readonly TradeProposal[]>;
}
