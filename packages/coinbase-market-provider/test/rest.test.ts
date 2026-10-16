import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { CoinbasePublicRestTradeSource, fetchCoinbaseTradeGap } from "../src/index.js";

describe("Coinbase public REST trade backfill", () => {
  it("requests a bounded recent window and returns the exact range ascending", async () => {
    const requests: string[] = [];
    const source = new CoinbasePublicRestTradeSource(
      { endpoint: "https://api.exchange.coinbase.com", timeoutMs: 1000 },
      (url) => {
        requests.push(url);
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                trade_id: 13,
                time: "2026-01-01T00:00:03.000Z",
                size: "1",
                price: "103",
                side: "sell",
              },
              {
                trade_id: 12,
                time: "2026-01-01T00:00:02.000Z",
                size: "1",
                price: "102",
                side: "buy",
              },
              {
                trade_id: 11,
                time: "2026-01-01T00:00:01.000Z",
                size: "1",
                price: "101",
                side: "sell",
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      },
    );
    const trades = await fetchCoinbaseTradeGap(source, "SOL-USD", 11, 12, 10);
    expect(trades.map((trade) => (trade as { trade_id: number }).trade_id)).toEqual([11, 12]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("/products/SOL-USD/trades?limit=2&after=13");
  });

  it("rejects insecure remote endpoints and unsuccessful responses", async () => {
    expect(
      () => new CoinbasePublicRestTradeSource({ endpoint: "http://example.com", timeoutMs: 1000 }),
    ).toThrow(/HTTPS/);
    const source = new CoinbasePublicRestTradeSource(
      { endpoint: "http://127.0.0.1:8080", timeoutMs: 1000 },
      () => Promise.resolve(new Response("unavailable", { status: 503 })),
    );
    await expect(source.fetchTrades("SOL-USD", 1, 2, 10)).rejects.toThrow(/503/);
  });

  it("recovers an exact range through a real bounded local HTTP endpoint", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify([
          { trade_id: 22, time: "2026-01-01T00:00:02.000Z", size: "2", price: "102", side: "buy" },
          { trade_id: 21, time: "2026-01-01T00:00:01.000Z", size: "1", price: "101", side: "sell" },
          { trade_id: 20, time: "2026-01-01T00:00:00.000Z", size: "3", price: "100", side: "buy" },
        ]),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const source = new CoinbasePublicRestTradeSource({
        endpoint: `http://127.0.0.1:${String(address.port)}`,
        timeoutMs: 1000,
      });
      const trades = await fetchCoinbaseTradeGap(source, "SOL-USD", 20, 21, 10);
      expect(trades.map((trade) => (trade as { trade_id: number }).trade_id)).toEqual([20, 21]);
      expect(requests).toEqual(["/products/SOL-USD/trades?limit=2&after=22"]);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
