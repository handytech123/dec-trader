import { describe, expect, it, vi } from "vitest";
import { NansenReadOnlyClient, nansenHoldingMetrics } from "../src/index.js";
import type { NansenAccessError } from "../src/index.js";

describe("NansenReadOnlyClient", () => {
  it("makes a bounded authenticated read-only request and hashes the response", async () => {
    const fetcher = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ apikey: "fixture-key" });
      if (typeof init?.body !== "string") throw new Error("request body must be JSON text");
      expect(JSON.parse(init.body)).toEqual({
        chains: ["solana"],
        pagination: { page: 1, per_page: 10 },
        order_by: [{ field: "value_usd", direction: "DESC" }],
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                chain: "solana",
                token_address: "fixture-mint",
                token_symbol: "SOL",
                token_sectors: ["Layer 1"],
                value_usd: 1000,
                balance_24h_percent_change: 2.5,
                holders_count: 10,
                share_of_holdings_percent: 0.01,
                token_age_days: 1000,
                market_cap_usd: 50_000,
              },
            ],
            pagination: { page: 1, per_page: 10, is_last_page: true },
          }),
          { status: 200 },
        ),
      );
    });
    const client = new NansenReadOnlyClient({ apiKey: "fixture-key" }, fetcher);
    const result = await client.smartMoneyHoldings({
      chain: "solana",
      perPage: 10,
      observedAt: "2026-10-06T00:00:00.000Z",
    });
    expect(result).toMatchObject({
      provider: "nansen",
      endpoint: "smart-money/holdings",
      adapterVersion: 1,
    });
    expect(result.responseHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.response.data[0]?.token_symbol).toBe("SOL");
  });

  it("rejects malformed holdings rather than silently accepting provider drift", async () => {
    const client = new NansenReadOnlyClient({ apiKey: "fixture-key" }, () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ token_symbol: "SOL", value_usd: "not-a-number" }],
            pagination: { page: 1, per_page: 1, is_last_page: true },
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(client.smartMoneyHoldings({ chain: "solana" })).rejects.toThrow();
  });

  it("rejects unsafe configuration, excessive pages and provider errors", async () => {
    expect(
      () => new NansenReadOnlyClient({ endpoint: "https://example.com", apiKey: "x" }),
    ).toThrow(/host/);
    expect(() => new NansenReadOnlyClient({ apiKey: " " })).toThrow(/key/);
    const client = new NansenReadOnlyClient({ apiKey: "fixture-key" }, () =>
      Promise.resolve(new Response("forbidden", { status: 403 })),
    );
    await expect(client.smartMoneyHoldings({ chain: "solana", perPage: 101 })).rejects.toThrow();
    await expect(client.smartMoneyHoldings({ chain: "solana" })).rejects.toThrow(/403/);
  });

  it("exposes bounded provider error details for durable cost-control decisions", async () => {
    const client = new NansenReadOnlyClient({ apiKey: "fixture-key" }, () =>
      Promise.resolve(new Response('{"message":"insufficient credits"}', { status: 403 })),
    );
    await expect(client.smartMoneyHoldings({ chain: "solana" })).rejects.toMatchObject({
      name: "NansenAccessError",
      status: 403,
      providerReason: '{"message":"insufficient credits"}',
    } satisfies Partial<NansenAccessError>);
  });

  it("maps a validated holding into vendor-neutral point-in-time metrics", () => {
    const metrics = nansenHoldingMetrics({
      chain: "solana",
      token_address: "fixture-mint",
      token_symbol: "SOL",
      token_sectors: ["Layer 1"],
      value_usd: 1000,
      balance_24h_percent_change: -1.5,
      holders_count: 7,
      share_of_holdings_percent: 0.25,
      token_age_days: 100,
      market_cap_usd: 20_000,
    });
    expect(metrics).toHaveLength(5);
    expect(metrics[1]).toEqual({
      metric: "smart_money_balance_24h_percent_change",
      value: -1.5,
      unit: "PERCENT",
    });
  });

  it("retrieves common Solana labels without requesting premium labels", async () => {
    const address = "11111111111111111111111111111111";
    const fetcher = vi.fn((url: URL | RequestInfo, init?: RequestInit) => {
      const href = url instanceof URL ? url.href : typeof url === "string" ? url : url.url;
      expect(href).toContain("/profiler/address/labels");
      expect(href).not.toContain("premium-labels");
      if (typeof init?.body !== "string") throw new Error("request body must be JSON text");
      expect(JSON.parse(init.body)).toEqual({
        address,
        chain: "solana",
        pagination: { page: 1, per_page: 100 },
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ label: "Exchange", category: "entity" }],
            pagination: { page: 1, per_page: 100, is_last_page: true },
            hint: "Provider metadata may be added without changing label semantics",
          }),
          { status: 200 },
        ),
      );
    });
    const result = await new NansenReadOnlyClient({ apiKey: "fixture-key" }, fetcher).addressLabels(
      {
        address,
      },
    );
    expect(result.endpoint).toBe("profiler/address/labels");
    expect(result.response.data).toEqual([{ label: "Exchange", category: "entity" }]);
  });

  it("requires an explicit premium flag for the expensive premium-label endpoint", async () => {
    const fetcher = vi.fn((url: URL | RequestInfo) => {
      const href = url instanceof URL ? url.href : typeof url === "string" ? url : url.url;
      expect(href).toContain("/profiler/address/premium-labels");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [],
            pagination: { page: 1, per_page: 100, is_last_page: true },
          }),
          { status: 200 },
        ),
      );
    });
    await new NansenReadOnlyClient({ apiKey: "fixture-key" }, fetcher).addressLabels({
      address: "11111111111111111111111111111111",
      premium: true,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
