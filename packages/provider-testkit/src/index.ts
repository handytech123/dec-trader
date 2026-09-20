import type {
  NormalizedQuote,
  QuoteProviderPort,
} from "@autonomous-trading-lab/execution-contracts";

export type MockOutcome =
  | { readonly kind: "quote"; readonly quote: NormalizedQuote }
  | { readonly kind: "timeout" }
  | { readonly kind: "rate-limit" }
  | { readonly kind: "malformed" };

export class MockQuoteProvider implements QuoteProviderPort {
  public constructor(private readonly outcome: MockOutcome) {}

  public async getQuote(): Promise<NormalizedQuote> {
    await Promise.resolve();
    switch (this.outcome.kind) {
      case "quote":
        return this.outcome.quote;
      case "timeout":
        throw new Error("synthetic provider timeout");
      case "rate-limit":
        throw new Error("synthetic provider rate limit");
      case "malformed":
        throw new Error("synthetic malformed provider response");
    }
  }
}
