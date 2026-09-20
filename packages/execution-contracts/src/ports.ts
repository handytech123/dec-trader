import type {
  ExecutionAuthorization,
  NormalizedQuote,
  QuoteRequest,
  RiskPrecheck,
} from "./contracts.js";

/** Phase 0 port only. Implementations are forbidden in this package. */
export interface QuoteProviderPort {
  getQuote(request: QuoteRequest): Promise<NormalizedQuote>;
}

/** Produces evidence, never signing authority. */
export interface RiskPrecheckPort {
  evaluateProposalAndQuote(proposalHash: string, quote: NormalizedQuote): Promise<RiskPrecheck>;
}

/** The future signer revalidates policy independently; upstream inspection is never trusted. */
export interface PolicySignerPort {
  authorizeInspectedSwap(
    authorization: ExecutionAuthorization,
    inspectedSwapHash: string,
  ): Promise<{
    signatureReference: string;
  }>;
}
