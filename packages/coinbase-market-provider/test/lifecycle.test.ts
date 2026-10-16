import { describe, expect, it } from "vitest";
import {
  BoundedMarketStream,
  type PublicMarketConnection,
  type PublicMarketConnectionFactory,
} from "../src/index.js";

class FixtureFactory implements PublicMarketConnectionFactory {
  public attempts = 0;
  public closes = 0;
  public constructor(private readonly failAttempts: number) {}

  public connect(): Promise<PublicMarketConnection> {
    this.attempts += 1;
    if (this.attempts <= this.failAttempts) return Promise.reject(new Error("disconnected"));
    const recordClose = (): void => {
      this.closes += 1;
    };
    return Promise.resolve({
      async *messages() {
        await Promise.resolve();
        yield { type: "snapshot" };
        yield { type: "l2update" };
      },
      close() {
        recordClose();
        return Promise.resolve();
      },
    });
  }
}

describe("bounded public market connection lifecycle", () => {
  it("backs off, reconnects, resets state, and stops on abort", async () => {
    const factory = new FixtureFactory(1);
    const delays: number[] = [];
    let resets = 0;
    const controller = new AbortController();
    const stream = new BoundedMarketStream(
      factory,
      { maximumAttempts: 2, baseDelayMs: 10, maximumDelayMs: 100 },
      (delay) => {
        delays.push(delay);
        return Promise.resolve();
      },
    );
    const result = await stream.run(
      () => {
        controller.abort();
        return Promise.resolve();
      },
      controller.signal,
      () => {
        resets += 1;
      },
    );
    expect(result).toEqual({ connections: 1, messages: 1, reconnects: 1 });
    expect(delays).toEqual([10]);
    expect(resets).toBe(1);
    expect(factory.closes).toBe(1);
  });

  it("fails after the bounded reconnect budget", async () => {
    const stream = new BoundedMarketStream(
      new FixtureFactory(3),
      { maximumAttempts: 1, baseDelayMs: 0, maximumDelayMs: 0 },
      () => Promise.resolve(),
    );
    await expect(
      stream.run(
        () => Promise.resolve(),
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toThrow("disconnected");
  });

  it("closes and wakes a silent connection when its observation budget expires", async () => {
    const controller = new AbortController();
    let wake: (() => void) | undefined;
    let closes = 0;
    let closed = false;
    const factory: PublicMarketConnectionFactory = {
      connect() {
        queueMicrotask(() => {
          controller.abort();
        });
        return Promise.resolve({
          // The fixture intentionally models a connection that never emits a message.
          // eslint-disable-next-line require-yield
          async *messages() {
            if (closed) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          },
          close() {
            closes += 1;
            closed = true;
            wake?.();
            return Promise.resolve();
          },
        });
      },
    };
    const stream = new BoundedMarketStream(factory, {
      maximumAttempts: 0,
      baseDelayMs: 0,
      maximumDelayMs: 0,
    });
    await expect(
      stream.run(
        () => Promise.resolve(),
        controller.signal,
        () => undefined,
      ),
    ).resolves.toEqual({ connections: 1, messages: 0, reconnects: 0 });
    expect(closes).toBe(1);
  });
});
