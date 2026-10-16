import { Decimal } from "decimal.js";
import type { PaperFill } from "./paper-broker.js";

export interface PaperPortfolio {
  readonly portfolioId: string;
  readonly version: number;
  readonly balancesAtomic: Readonly<Record<string, string>>;
}

export interface PaperLedgerEntry {
  readonly mode: "PAPER_ONLY";
  readonly portfolioId: string;
  readonly portfolioVersion: number;
  readonly orderId: string;
  readonly inputAsset: string;
  readonly outputAsset: string;
  readonly inputAtomic: string;
  readonly outputAtomic: string;
  readonly executionCostOutputAtomic: string;
  readonly networkFeeAtomic: string;
}

export type PaperLedgerResult =
  | {
      readonly status: "NOT_APPLIED";
      readonly reason: "FILL_REJECTED" | "INSUFFICIENT_PAPER_BALANCE";
      readonly portfolio: PaperPortfolio;
    }
  | {
      readonly status: "APPLIED";
      readonly portfolio: PaperPortfolio;
      readonly entry: PaperLedgerEntry;
    };

const atomic = (value: string, label: string): Decimal => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be atomic units`);
  return new Decimal(value);
};

/** Applies a simulated fill to an immutable paper ledger. It cannot access real balances. */
export function applyPaperFill(input: {
  readonly portfolio: PaperPortfolio;
  readonly inputAsset: string;
  readonly outputAsset: string;
  readonly fill: PaperFill;
}): PaperLedgerResult {
  const { portfolio, inputAsset, outputAsset, fill } = input;
  if (!portfolio.portfolioId || !inputAsset || !outputAsset)
    throw new Error("paper ledger identity fields are required");
  if (inputAsset === outputAsset) throw new Error("paper input and output assets must differ");
  if (!Number.isInteger(portfolio.version) || portfolio.version < 0)
    throw new Error("paper portfolio version must be a non-negative integer");
  if (fill.status === "REJECTED")
    return { status: "NOT_APPLIED", reason: "FILL_REJECTED", portfolio };

  const balances = new Map<string, Decimal>();
  for (const [asset, value] of Object.entries(portfolio.balancesAtomic))
    balances.set(asset, atomic(value, `${asset} balance`));
  const availableInput = balances.get(inputAsset) ?? new Decimal(0);
  const filledInput = atomic(fill.inputAtomic, "filled input");
  if (availableInput.lessThan(filledInput))
    return { status: "NOT_APPLIED", reason: "INSUFFICIENT_PAPER_BALANCE", portfolio };
  const output = atomic(fill.outputAtomic, "filled output");
  balances.set(inputAsset, availableInput.minus(filledInput));
  balances.set(outputAsset, (balances.get(outputAsset) ?? new Decimal(0)).plus(output));
  const balancesAtomic = Object.fromEntries(
    [...balances.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([asset, value]) => [asset, value.toFixed(0)]),
  );
  const nextPortfolio = {
    portfolioId: portfolio.portfolioId,
    version: portfolio.version + 1,
    balancesAtomic,
  };
  return {
    status: "APPLIED",
    portfolio: nextPortfolio,
    entry: {
      mode: "PAPER_ONLY",
      portfolioId: portfolio.portfolioId,
      portfolioVersion: nextPortfolio.version,
      orderId: fill.orderId,
      inputAsset,
      outputAsset,
      inputAtomic: fill.inputAtomic,
      outputAtomic: fill.outputAtomic,
      executionCostOutputAtomic: fill.executionCostOutputAtomic,
      networkFeeAtomic: fill.networkFeeAtomic,
    },
  };
}
