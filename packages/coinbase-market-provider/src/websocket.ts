import type { PublicMarketConnection, PublicMarketConnectionFactory } from "./lifecycle.js";

interface SocketEvent {
  readonly data?: unknown;
}

export interface PublicWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: SocketEvent) => void,
    options?: { readonly once?: boolean },
  ): void;
}

export type PublicWebSocketConstructor = new (url: string) => PublicWebSocket;

export interface CoinbaseWebSocketOptions {
  readonly endpoint: string;
  readonly productIds: readonly string[];
  readonly connectionTimeoutMs: number;
}

class CoinbaseWebSocketConnection implements PublicMarketConnection {
  readonly #queue: unknown[] = [];
  readonly #waiters: (() => void)[] = [];
  #ended = false;
  #failure: Error | undefined;

  public constructor(private readonly socket: PublicWebSocket) {
    socket.addEventListener("message", (event) => {
      try {
        if (typeof event.data !== "string") throw new Error("expected a text WebSocket message");
        this.#queue.push(JSON.parse(event.data) as unknown);
      } catch (error: unknown) {
        this.#failure = error instanceof Error ? error : new Error(String(error));
        this.#ended = true;
      }
      this.#wake();
    });
    socket.addEventListener("error", () => {
      this.#failure = new Error("Coinbase public WebSocket failed");
      this.#ended = true;
      this.#wake();
    });
    socket.addEventListener("close", () => {
      this.#ended = true;
      this.#wake();
    });
  }

  #wake(): void {
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  public async *messages(): AsyncIterable<unknown> {
    while (!this.#ended || this.#queue.length > 0) {
      const message = this.#queue.shift();
      if (message !== undefined) {
        yield message;
        continue;
      }
      if (this.#failure) throw this.#failure;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    if (this.#failure) throw this.#failure;
  }

  public close(): Promise<void> {
    this.#ended = true;
    if (this.socket.readyState < 2) this.socket.close(1000, "bounded observation complete");
    this.#wake();
    return Promise.resolve();
  }
}

export class CoinbasePublicWebSocketFactory implements PublicMarketConnectionFactory {
  readonly #endpoint: string;
  readonly #productIds: readonly string[];
  readonly #connectionTimeoutMs: number;

  public constructor(
    candidate: CoinbaseWebSocketOptions,
    private readonly Socket: PublicWebSocketConstructor = WebSocket,
  ) {
    const endpoint = new URL(candidate.endpoint);
    if (
      endpoint.protocol !== "wss:" &&
      !(
        endpoint.protocol === "ws:" &&
        (endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1")
      )
    )
      throw new Error("market-data endpoint must use WSS unless it is local");
    if (candidate.productIds.length < 1 || candidate.productIds.length > 10)
      throw new Error("between 1 and 10 product IDs are required");
    if (candidate.productIds.some((productId) => !/^[A-Z0-9]+-[A-Z0-9]+$/.test(productId)))
      throw new Error("invalid Coinbase product ID");
    if (
      !Number.isInteger(candidate.connectionTimeoutMs) ||
      candidate.connectionTimeoutMs < 1000 ||
      candidate.connectionTimeoutMs > 30_000
    )
      throw new Error("connectionTimeoutMs must be between 1000 and 30000");
    this.#endpoint = endpoint.toString();
    this.#productIds = [...new Set(candidate.productIds)];
    this.#connectionTimeoutMs = candidate.connectionTimeoutMs;
  }

  public async connect(): Promise<PublicMarketConnection> {
    const socket = new this.Socket(this.#endpoint);
    const connection = new CoinbaseWebSocketConnection(socket);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close(1000, "connection timeout");
        reject(new Error("Coinbase public WebSocket connection timed out"));
      }, this.#connectionTimeoutMs);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          socket.send(
            JSON.stringify({
              type: "subscribe",
              product_ids: this.#productIds,
              channels: ["matches", "heartbeat"],
            }),
          );
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("Coinbase public WebSocket connection failed"));
        },
        { once: true },
      );
    });
    return connection;
  }
}
