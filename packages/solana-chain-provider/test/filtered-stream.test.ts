import { describe, expect, it } from "vitest";
import { parseFilteredTransaction, transactionSubscribeRequest } from "../src/index.js";

const systemProgram = "11111111111111111111111111111111";

describe("filtered Solana stream boundary", () => {
  it("builds a read-only confirmed subscription with bounded filters", () => {
    expect(
      transactionSubscribeRequest({
        filterId: "core-programs-v1",
        accountInclude: [systemProgram],
      }),
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "transactionSubscribe",
      params: [
        { failed: false, vote: false, accountInclude: [systemProgram] },
        {
          commitment: "confirmed",
          encoding: "jsonParsed",
          transactionDetails: "full",
          maxSupportedTransactionVersion: 1,
        },
      ],
    });
  });

  it("parses notifications without discarding the original payload", () => {
    const payload = {
      jsonrpc: "2.0",
      method: "transactionNotification",
      params: {
        subscription: 7,
        result: {
          context: { slot: 123 },
          value: {
            signature: "5".repeat(64),
            transaction: { message: {} },
            meta: null,
          },
        },
      },
    };
    const record = parseFilteredTransaction(payload, {
      providerId: "helius",
      filterId: "core-programs-v1",
      receivedAt: "2026-10-03T12:00:00.000Z",
    });
    expect(record.slot).toBe("123");
    expect(record.signature).toBe("5".repeat(64));
    expect(record.payload).toBe(payload);
  });

  it("parses the current Helius direct-result notification format", () => {
    const payload = {
      jsonrpc: "2.0",
      method: "transactionNotification",
      params: {
        subscription: 8,
        result: {
          slot: 456,
          signature: "6".repeat(64),
          transaction: { transaction: { message: {} }, meta: { err: null } },
        },
      },
    };
    expect(
      parseFilteredTransaction(payload, {
        providerId: "helius",
        filterId: "verified-entities-v1",
        receivedAt: "2026-10-10T12:00:00.000Z",
      }),
    ).toMatchObject({ slot: "456", signature: "6".repeat(64), payload });
  });

  it("rejects invalid and duplicate filters", () => {
    expect(() => transactionSubscribeRequest({ filterId: "x", accountInclude: [] })).toThrow(
      /empty/,
    );
    expect(() =>
      transactionSubscribeRequest({
        filterId: "x",
        accountInclude: [systemProgram, systemProgram],
      }),
    ).toThrow(/duplicates/);
  });
});
