import { describe, expect, it } from "vitest";
import { assessRoundTripRoute, USDC_MINT } from "../src/jupiter.js";

const mint = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const response = (inputMint: string, outputMint: string, inAmount: string, outAmount: string) =>
  new Response(
    JSON.stringify({
      inputMint,
      outputMint,
      inAmount,
      outAmount,
      priceImpactPct: "0.001",
      routePlan: [],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("round-trip route assessment", () => {
  it("passes a liquid buy and sell route and measures round-trip loss", async () => {
    const replies = [
      response(USDC_MINT, mint, "100000000", "50000000"),
      response(mint, USDC_MINT, "50000000", "99000000"),
    ];
    const fetcher: typeof fetch = () =>
      Promise.resolve(replies.shift() ?? new Response(null, { status: 500 }));
    const result = await assessRoundTripRoute(mint, "100000000", fetcher);
    expect(result.status).toBe("PASS");
    expect(result.roundTripLossBps).toBe("100");
  });

  it("blocks when no quote route exists", async () => {
    const fetcher: typeof fetch = () => Promise.resolve(new Response(null, { status: 400 }));
    const result = await assessRoundTripRoute(mint, "100000000", fetcher);
    expect(result.status).toBe("BLOCK");
    expect(result.reason).toBe("quote HTTP 400");
  });
});
