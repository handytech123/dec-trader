import { describe, expect, it } from "vitest";
import { CoinbasePublicWebSocketFactory, type PublicWebSocket } from "../src/index.js";

class FakeSocket implements PublicWebSocket {
  public static latest: FakeSocket | undefined;
  public readyState = 0;
  public readonly sent: string[] = [];
  readonly #listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();

  public constructor(public readonly url: string) {
    FakeSocket.latest = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
    });
  }

  public addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void,
  ): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  public emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

describe("Coinbase public WebSocket transport", () => {
  it("subscribes only to public observation channels and yields decoded messages", async () => {
    const factory = new CoinbasePublicWebSocketFactory(
      {
        endpoint: "wss://ws-feed.exchange.coinbase.com",
        productIds: ["BTC-USD"],
        connectionTimeoutMs: 1000,
      },
      FakeSocket,
    );
    const connection = await factory.connect();
    const socket = FakeSocket.latest;
    if (!socket) throw new Error("fake socket was not constructed");
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
      type: "subscribe",
      product_ids: ["BTC-USD"],
      channels: ["matches", "heartbeat"],
    });
    const iterator = connection.messages()[Symbol.asyncIterator]();
    socket.emit("message", { data: JSON.stringify({ type: "heartbeat", sequence: 1 }) });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "heartbeat", sequence: 1 },
    });
    await connection.close();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("rejects insecure remote endpoints and unbounded product lists", () => {
    expect(
      () =>
        new CoinbasePublicWebSocketFactory(
          { endpoint: "ws://example.com", productIds: ["BTC-USD"], connectionTimeoutMs: 1000 },
          FakeSocket,
        ),
    ).toThrow(/WSS/);
    expect(
      () =>
        new CoinbasePublicWebSocketFactory(
          { endpoint: "wss://example.com", productIds: [], connectionTimeoutMs: 1000 },
          FakeSocket,
        ),
    ).toThrow(/product IDs/);
  });
});
