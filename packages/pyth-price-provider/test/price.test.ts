import { describe, expect, it } from "vitest";
import { PythHermesPriceSource } from "../src/index.js";

const feed = "ef0d8b6fda2ceba41a5f89ab2f8f6497212d51ea21686915e8d1ac5d5e54b56d";

describe("Pyth Hermes price source", () => {
  it("authenticates, validates, and scales an exact price observation", async () => {
    const requests: { url: string; authorization: string | null }[] = [];
    const source = new PythHermesPriceSource(
      { endpoint: "https://pyth.example/hermes/", apiKey: "test-key", timeoutMs: 1000 },
      (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const headers = new Headers(init?.headers);
        requests.push({ url, authorization: headers.get("authorization") });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              parsed: [
                {
                  id: feed,
                  price: {
                    price: "123456789",
                    conf: "1000",
                    expo: -6,
                    publish_time: 1_700_000_000,
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        );
      },
    );
    await expect(source.latest([feed], "2026-01-01T00:00:00.000Z")).resolves.toEqual([
      {
        feedId: feed,
        price: "123.456789",
        confidence: "0.001",
        publishedAt: "2023-11-14T22:13:20.000Z",
        observedAt: "2026-01-01T00:00:00.000Z",
        source: "pyth-hermes-v2",
      },
    ]);
    expect(requests[0]?.url).toContain(`ids%5B%5D=0x${feed}`);
    expect(requests[0]?.authorization).toBe("Bearer test-key");
  });

  it("rejects missing credentials, unsafe endpoints, invalid feeds, and omitted results", async () => {
    expect(
      () =>
        new PythHermesPriceSource({ endpoint: "http://example.com", apiKey: "x", timeoutMs: 1000 }),
    ).toThrow(/HTTPS/);
    expect(
      () =>
        new PythHermesPriceSource({ endpoint: "https://example.com", apiKey: "", timeoutMs: 1000 }),
    ).toThrow(/key/);
    const source = new PythHermesPriceSource(
      { endpoint: "https://example.com", apiKey: "x", timeoutMs: 1000 },
      () => Promise.resolve(new Response(JSON.stringify({ parsed: [] }), { status: 200 })),
    );
    await expect(source.latest(["bad"])).rejects.toThrow();
    await expect(source.latest([feed])).rejects.toThrow(/omitted/);
  });
});
