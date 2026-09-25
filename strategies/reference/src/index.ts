import type { TradeProposal } from "@autonomous-trading-lab/domain";

export interface ReferenceSignal {
  readonly proposalId: string;
  readonly strategyVersionId: string;
  readonly experimentId: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly requestedInputAtomic: string;
  readonly validUntil: string;
  readonly return5m: number;
  readonly volumeAcceleration: number;
  readonly liquidityUsd: number;
  readonly walletQuality?: number;
}

function proposal(signal: ReferenceSignal, thesisCode: string): TradeProposal {
  return {
    proposalId: signal.proposalId,
    strategyVersionId: signal.strategyVersionId,
    experimentId: signal.experimentId,
    side: "BUY",
    inputMint: signal.inputMint,
    outputMint: signal.outputMint,
    requestedInputAtomic: signal.requestedInputAtomic,
    thesisCode,
    signalValues: {
      return5m: signal.return5m,
      volumeAcceleration: signal.volumeAcceleration,
      liquidityUsd: signal.liquidityUsd,
      walletQuality: signal.walletQuality ?? null,
    },
    validUntil: signal.validUntil,
  };
}

export function momentumBaseline(signal: ReferenceSignal): readonly TradeProposal[] {
  if (signal.return5m < 0.01 || signal.volumeAcceleration < 1.2 || signal.liquidityUsd < 50_000)
    return [];
  return [proposal(signal, "MOMENTUM_BASELINE_V1")];
}

export function walletConfirmedMomentum(signal: ReferenceSignal): readonly TradeProposal[] {
  if (momentumBaseline(signal).length === 0 || (signal.walletQuality ?? 0) < 0.7) return [];
  return [proposal(signal, "WALLET_CONFIRMED_MOMENTUM_V1")];
}

export function quorumEnsemble(
  constituentProposals: readonly (readonly TradeProposal[])[],
  quorum: number,
): readonly TradeProposal[] {
  if (!Number.isInteger(quorum) || quorum <= 0)
    throw new Error("quorum must be a positive integer");
  const agreeing = constituentProposals.filter((proposals) => proposals.length > 0);
  if (agreeing.length < quorum) return [];
  return agreeing[0] ?? [];
}
