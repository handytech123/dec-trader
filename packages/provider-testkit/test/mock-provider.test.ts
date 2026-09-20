import { describe, expect, it } from "vitest";
import type { NormalizedQuote, QuoteRequest } from "@autonomous-trading-lab/execution-contracts";
import { MockQuoteProvider } from "../src/index.js";

const request = {} as QuoteRequest;
const quote = {} as NormalizedQuote;

describe("mock quote provider", () => {
  it("returns the configured synthetic quote", async () => {
    await expect(new MockQuoteProvider({ kind: "quote", quote }).getQuote(request)).resolves.toBe(
      quote,
    );
  });

  it.each(["timeout", "rate-limit", "malformed"] as const)("fails closed for %s", async (kind) => {
    await expect(new MockQuoteProvider({ kind }).getQuote(request)).rejects.toThrow("synthetic");
  });
});
