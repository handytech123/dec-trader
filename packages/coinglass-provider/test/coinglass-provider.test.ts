import { describe, expect, it, vi } from "vitest";
import { CoinGlassReadOnlyClient } from "../src/index.js";

describe("CoinGlassReadOnlyClient", () => {
  it("requests bounded open-interest evidence and hashes it", async () => {
    const fetcher = vi.fn((url: URL | RequestInfo, init?: RequestInit) => {
      const requestUrl =
        url instanceof URL ? url.toString() : typeof url === "string" ? url : url.url;
      expect(requestUrl).toContain("symbol=SOL");
      expect(init?.headers).toMatchObject({ "CG-API-KEY": "fixture-key" });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            code: "0",
            msg: "success",
            data: [{ exchange: "All", symbol: "SOL", open_interest_usd: 123 }],
          }),
          { status: 200 },
        ),
      );
    });
    const client = new CoinGlassReadOnlyClient({ apiKey: "fixture-key" }, fetcher);
    const result = await client.openInterestByExchange("sol", "2026-10-06T00:00:00.000Z");
    expect(result.symbol).toBe("SOL");
    expect(result.data).toHaveLength(1);
    expect(result.responseHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("fails closed on unsafe hosts, malformed symbols and provider errors", async () => {
    expect(
      () => new CoinGlassReadOnlyClient({ endpoint: "https://example.com", apiKey: "x" }),
    ).toThrow(/host/);
    const client = new CoinGlassReadOnlyClient({ apiKey: "fixture-key" }, () =>
      Promise.resolve(new Response("denied", { status: 403 })),
    );
    await expect(client.openInterestByExchange("bad symbol")).rejects.toThrow();
    await expect(client.openInterestByExchange("SOL")).rejects.toThrow(/403/);
  });

  it("distinguishes plan restrictions returned with HTTP 200", async () => {
    const client = new CoinGlassReadOnlyClient({ apiKey: "fixture-key" }, () =>
      Promise.resolve(new Response(JSON.stringify({ code: "401", msg: "Upgrade plan" }))),
    );
    await expect(client.openInterestByExchange("SOL")).rejects.toThrow(/capability unavailable/);
  });
});
