import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  CoinbaseMarketSession,
  CoinbaseTradeSequenceError,
  fetchCoinbaseTradeGap,
} from "../src/index.js";

const fixturePath = new URL("../fixtures/market-messages.json", import.meta.url);

async function fixture(): Promise<{
  snapshot: unknown;
  update: unknown;
  matches: unknown[];
}> {
  // Test-local URL is a constant under the package fixture directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return JSON.parse(await readFile(fixturePath, "utf8")) as {
    snapshot: unknown;
    update: unknown;
    matches: unknown[];
  };
}

describe("Coinbase public market fixture adapter", () => {
  it("rebuilds L2 state from snapshot and absolute-size updates", async () => {
    const messages = await fixture();
    const session = new CoinbaseMarketSession();
    expect(session.acceptBookMessage(messages.snapshot).sequence).toBe("1");
    expect(session.acceptBookMessage(messages.update)).toEqual({
      sequence: "2",
      bids: [
        { price: "100.00", size: "1.5" },
        { price: "99.00", size: "2.0" },
      ],
      asks: [],
    });
    session.reconnect();
    expect(() => session.acceptBookMessage(messages.update)).toThrow(/snapshot required/);
  });

  it("normalizes maker-side matches into aggressor-side canonical trades", async () => {
    const messages = await fixture();
    const session = new CoinbaseMarketSession();
    const first = session.acceptMatch(messages.matches[0], "2026-01-01T00:00:04.000Z");
    const second = session.acceptMatch(messages.matches[1], "2026-01-01T00:00:04.000Z");
    expect(first.side).toBe("BUY");
    expect(second.side).toBe("SELL");
    expect(first.quantity).toBe("5.25");
  });

  it("detects dropped match messages", async () => {
    const messages = await fixture();
    const session = new CoinbaseMarketSession();
    session.acceptMatch(messages.matches[0], "2026-01-01T00:00:04.000Z");
    const skipped = { ...(messages.matches[1] as Record<string, unknown>), trade_id: 12 };
    expect(() => session.acceptMatch(skipped, "2026-01-01T00:00:04.000Z")).toThrow(/gap/);
    try {
      session.acceptMatch(skipped, "2026-01-01T00:00:04.000Z");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(CoinbaseTradeSequenceError);
      expect(error).toMatchObject({
        productId: "SOL-USD",
        expectedTradeId: 11,
        receivedTradeId: 12,
        kind: "GAP",
      });
    }
  });

  it("accepts only complete contiguous bounded REST backfills", async () => {
    const messages = await fixture();
    const trades = await fetchCoinbaseTradeGap(
      {
        fetchTrades: () => Promise.resolve(messages.matches),
      },
      "SOL-USD",
      10,
      11,
      10,
    );
    expect(trades).toHaveLength(2);
    await expect(
      fetchCoinbaseTradeGap(
        { fetchTrades: () => Promise.resolve([messages.matches[1]]) },
        "SOL-USD",
        10,
        11,
        10,
      ),
    ).rejects.toThrow(/complete/);
    await expect(
      fetchCoinbaseTradeGap({ fetchTrades: () => Promise.resolve([]) }, "SOL-USD", 1, 1001, 1000),
    ).rejects.toThrow(/bounded/);
  });
});
