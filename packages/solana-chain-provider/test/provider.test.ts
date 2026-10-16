import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpJsonRpcTransport, SolanaChainProvider, type JsonRpcTransport } from "../src/index.js";

const block = {
  blockHeight: 1,
  blockTime: null,
  blockhash: "blockhash",
  parentSlot: 0,
  previousBlockhash: "previous",
  transactions: [],
};

class MethodTransport implements JsonRpcTransport {
  public constructor(private readonly handler: (method: string) => unknown) {}

  public request(method: string): Promise<unknown> {
    const value = this.handler(method);
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Solana chain provider", () => {
  it("advertises only read-only block capability and reports health", async () => {
    const provider = new SolanaChainProvider(new MethodTransport(() => 12));
    expect(provider.providerId()).toBe("solana-rpc");
    expect(provider.capabilities()).toEqual(["CHAIN_BLOCKS"]);
    expect(provider.metadata()).toEqual({
      freshnessSeconds: 30,
      retryPolicy: "BOUNDED_EXPONENTIAL",
    });
    await expect(provider.health()).resolves.toEqual(
      expect.objectContaining({ status: "HEALTHY" }),
    );
  });

  it("degrades health when the RPC is unavailable", async () => {
    const provider = new SolanaChainProvider(new MethodTransport(() => new Error("offline")));
    await expect(provider.health()).resolves.toEqual(
      expect.objectContaining({ status: "UNAVAILABLE", message: "offline" }),
    );
  });

  it("validates block ranges and official block responses", async () => {
    const provider = new SolanaChainProvider(
      new MethodTransport((method) => {
        if (method === "getBlocks") return [4, 5];
        if (method === "getBlock") return block;
        return 5;
      }),
    );
    await expect(provider.confirmedBlockSlots(5, 4)).resolves.toEqual([]);
    await expect(provider.confirmedBlockSlots(4, 5)).resolves.toEqual([4, 5]);
    await expect(provider.confirmedBlockSlots(0, 500_001)).rejects.toThrow(/500000/);
    await expect(provider.getBlock("1")).resolves.toEqual(
      expect.objectContaining({ sequence: "1", sourceTimestamp: "1970-01-01T00:00:00.000Z" }),
    );
    await expect(provider.getBlock(String(Number.MAX_SAFE_INTEGER + 1))).rejects.toThrow(/safe/);
  });

  it("keeps transfer extraction and push streaming outside Phase 1.1", async () => {
    const provider = new SolanaChainProvider(new MethodTransport(() => 1));
    await expect(provider.getTransfers()).rejects.toThrow(/Phase 1.2/);
    await expect(provider.streamEvents()).rejects.toThrow(/checkpointed/);
  });
});

describe("HTTP JSON-RPC transport", () => {
  it("requires HTTPS except for local development", () => {
    expect(() => new HttpJsonRpcTransport("http://rpc.example.com")).toThrow(/HTTPS/);
    expect(() => new HttpJsonRpcTransport("http://localhost:8899")).not.toThrow();
    expect(() => new HttpJsonRpcTransport("https://rpc.example.com", 20_000, -1)).toThrow(
      /minimum request interval/,
    );
  });

  it("paces concurrent requests through one bounded gate", async () => {
    const starts: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        starts.push(Date.now());
        return Promise.resolve(
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }), {
            status: 200,
          }),
        );
      }),
    );
    const transport = new HttpJsonRpcTransport("https://rpc.example.com", 20_000, 20);
    await Promise.all([transport.request("first", []), transport.request("second", [])]);
    expect(starts).toHaveLength(2);
    expect((starts.at(1) ?? 0) - (starts.at(0) ?? 0)).toBeGreaterThanOrEqual(15);
  });

  it("returns results and rejects JSON-RPC and HTTP failures", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const transport = new HttpJsonRpcTransport("https://rpc.example.com");

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }), { status: 200 }),
    );
    await expect(transport.request("getSlot", [])).resolves.toBe(42);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1 } }), {
        status: 200,
      }),
    );
    await expect(transport.request("getSlot", [])).rejects.toThrow(/returned an error/);

    fetchMock.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(transport.request("getSlot", [])).rejects.toThrow(/503/);
  });
});
