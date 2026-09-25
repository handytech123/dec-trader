import { describe, expect, it } from "vitest";
import { assessMarketIntegrity, classifyMarketIntegrity } from "../src/jupiter-token.js";

const mint = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";

describe("market integrity", () => {
  it("requires review for high concentration without treating it as definitive fraud", () => {
    const result = classifyMarketIntegrity({
      id: mint,
      holderCount: 20_000,
      organicScore: 90,
      organicScoreLabel: "high",
      isVerified: true,
      audit: { topHoldersPercentage: 60, isSus: false },
    });
    expect(result.status).toBe("REVIEW");
    expect(result.reasons).toContain("HIGH_TOP_HOLDER_CONCENTRATION");
  });
  it("blocks an extreme or explicitly suspicious distribution", () => {
    const result = classifyMarketIntegrity({
      id: mint,
      holderCount: 20_000,
      organicScore: 90,
      organicScoreLabel: "high",
      isVerified: true,
      audit: { topHoldersPercentage: 85, isSus: false },
    });
    expect(result.status).toBe("BLOCK");
  });
  it("returns review rather than pass when provider evidence is unavailable", async () => {
    const fetcher: typeof fetch = () => Promise.resolve(new Response(null, { status: 503 }));
    const result = await assessMarketIntegrity(mint, fetcher);
    expect(result.status).toBe("REVIEW");
    expect(result.reasons[0]).toContain("PROVIDER_ERROR");
  });
});
