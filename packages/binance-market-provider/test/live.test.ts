import { describe, expect, it } from "vitest";
import {
  BinanceDepthBook,
  BinancePublicRestDepthSource,
  BinancePublicWebSocketFactory,
  normalizeBinanceAggregateTrade,
  type BinancePublicSocket,
} from "../src/index.js";

class FakeSocket implements BinancePublicSocket {
  public static last: FakeSocket | undefined;
  public readonly listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  public readyState = 0;
  public closed = false;

  public constructor(public readonly url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  public addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  public close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit("close", {});
  }
}

describe("Binance public live market adapter", () => {
  it("connects to bounded aggregate-trade and depth streams", async () => {
    const factory = new BinancePublicWebSocketFactory(
      { endpoint: "wss://stream.binance.example", symbol: "SOLUSDT", connectionTimeoutMs: 1000 },
      FakeSocket,
    );
    const connection = await factory.connect();
    expect(FakeSocket.last?.url).toContain("solusdt%40aggTrade%2Fsolusdt%40depth%40100ms");
    const iterator = connection.messages()[Symbol.asyncIterator]();
    FakeSocket.last?.emit("message", {
      data: JSON.stringify({ stream: "solusdt@aggTrade", data: { e: "aggTrade" } }),
    });
    await expect(iterator.next()).resolves.toEqual({ value: { e: "aggTrade" }, done: false });
    await connection.close();
    expect(FakeSocket.last?.closed).toBe(true);
  });

  it("normalizes trades and maintains sequence-safe depth state", () => {
    const trade = normalizeBinanceAggregateTrade(
      {
        e: "aggTrade",
        E: 1_700_000_000_000,
        s: "SOLUSDT",
        a: 55,
        p: "145.25",
        q: "2.5",
        T: 1_700_000_000_000,
        m: true,
      },
      "2026-10-02T00:00:00.000Z",
    );
    expect(trade).toMatchObject({ venue: "binance-spot", side: "SELL", bookSequence: "55" });
    const book = new BinanceDepthBook({
      lastUpdateId: 10,
      bids: [["100", "1"]],
      asks: [["101", "2"]],
    });
    expect(
      book.apply({
        e: "depthUpdate",
        E: 1,
        s: "SOLUSDT",
        U: 11,
        u: 12,
        b: [["100", "0.00000000"]],
        a: [["102", "3"]],
      }),
    ).toBe(true);
    expect(book.view()).toEqual({
      sequence: "12",
      bids: [],
      asks: [
        { price: "101", size: "2" },
        { price: "102", size: "3" },
      ],
    });
    expect(() =>
      book.apply({ e: "depthUpdate", E: 2, s: "SOLUSDT", U: 14, u: 14, b: [], a: [] }),
    ).toThrow(/gap/);
  });

  it("validates REST snapshots and endpoint safety", async () => {
    const source = new BinancePublicRestDepthSource(
      { endpoint: "https://api.binance.example/", timeoutMs: 1000 },
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ lastUpdateId: 9, bids: [["1", "2"]], asks: [] })),
        ),
    );
    await expect(source.snapshot("SOLUSDT")).resolves.toMatchObject({ lastUpdateId: 9 });
    expect(
      () => new BinancePublicRestDepthSource({ endpoint: "http://example.com", timeoutMs: 1000 }),
    ).toThrow(/HTTPS/);
  });

  it("converts REST aggregate trades into the canonical websocket shape", async () => {
    const source = new BinancePublicRestDepthSource(
      { endpoint: "https://api.binance.example/", timeoutMs: 1000 },
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify([
              { a: 55, p: "145.25", q: "2.5", f: 70, l: 71, T: 1_700_000_000_000, m: true },
            ]),
          ),
        ),
    );

    await expect(source.aggregateTrades("SOLUSDT", 55, 55, 10)).resolves.toEqual([
      expect.objectContaining({
        e: "aggTrade",
        E: 1_700_000_000_000,
        s: "SOLUSDT",
        a: 55,
        p: "145.25",
        q: "2.5",
        T: 1_700_000_000_000,
        m: true,
      }),
    ]);
  });
});
