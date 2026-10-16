import { deterministicDomainId, type TradeProposal } from "@autonomous-trading-lab/domain";
import type { StrategyInput } from "./index.js";

export interface ResponseFailureStrategyConfig {
  readonly strategyVersionId: string;
  readonly experimentId: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly requestedInputAtomic: string;
  readonly minimumExpectedNetBps: number;
  readonly minimumEvidenceSampleSize: number;
  readonly proposalLifetimeSeconds: number;
}

const numeric = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Research candidate for "heavy selling with limited downside" absorption. It emits nothing unless
 * independently supplied evidence is explicitly supported and meets every configured gate.
 */
export function createResponseFailureStrategy(config: ResponseFailureStrategyConfig) {
  if (!Number.isInteger(config.minimumEvidenceSampleSize) || config.minimumEvidenceSampleSize < 1)
    throw new Error("minimum evidence sample size must be positive");
  if (!Number.isFinite(config.minimumExpectedNetBps))
    throw new Error("minimum expected net bps must be finite");
  if (!Number.isInteger(config.proposalLifetimeSeconds) || config.proposalLifetimeSeconds < 1)
    throw new Error("proposal lifetime must be positive");
  return {
    evaluate: ({ context, features }: StrategyInput): readonly TradeProposal[] => {
      const label = features.marketResponseLabel;
      const evidenceVerdict = features.evidenceVerdict;
      const sampleSize = numeric(features.evidenceSampleSize);
      const expectedNetBps = numeric(features.expectedNetBps);
      const replayReproducibility = numeric(features.replayReproducibility);
      if (
        label !== "HEAVY_SELLING_LIMITED_DOWNSIDE" ||
        evidenceVerdict !== "SUPPORTED" ||
        sampleSize === null ||
        sampleSize < config.minimumEvidenceSampleSize ||
        expectedNetBps === null ||
        expectedNetBps < config.minimumExpectedNetBps ||
        replayReproducibility === null ||
        replayReproducibility < 0.95
      )
        return [];
      const validUntil = new Date(
        Date.parse(context.evaluatedAt) + config.proposalLifetimeSeconds * 1000,
      ).toISOString();
      return [
        {
          proposalId: deterministicDomainId(
            "proposal",
            `${context.evaluationId}:${config.strategyVersionId}`,
          ),
          strategyVersionId: config.strategyVersionId,
          experimentId: config.experimentId,
          side: "BUY",
          inputMint: config.inputMint,
          outputMint: config.outputMint,
          requestedInputAtomic: config.requestedInputAtomic,
          thesisCode: "HEAVY_SELLING_LIMITED_DOWNSIDE_V1",
          signalValues: {
            marketResponseLabel: label,
            evidenceVerdict,
            evidenceSampleSize: sampleSize,
            expectedNetBps,
            replayReproducibility,
          },
          validUntil,
        },
      ];
    },
  };
}
