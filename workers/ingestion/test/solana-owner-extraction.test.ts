import { describe, expect, it } from "vitest";
import type { RawBlock } from "@autonomous-trading-lab/provider-sdk";
import { extractSolanaTokenAccountOwners } from "../src/solana-owner-extraction.js";

describe("Solana owner extraction", () => {
  it("extracts and deduplicates evidence-linked token-account owners", () => {
    const block = {
      chain: "solana",
      sequence: "1",
      providerRef: "block-1",
      sourceTimestamp: "2026-10-05T00:00:00.000Z",
      payload: {
        transactions: [
          {
            meta: {
              preTokenBalances: [{ accountIndex: 0, mint: "mint", owner: "owner" }],
              postTokenBalances: [{ accountIndex: 0, mint: "mint", owner: "owner" }],
            },
            transaction: {
              message: {
                accountKeys: [{ pubkey: "token-account" }],
                instructions: [
                  {
                    program: "spl-token",
                    parsed: {
                      type: "transfer",
                      info: {
                        source: "token-account",
                        destination: "other-token-account",
                      },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    } as RawBlock;
    const result = extractSolanaTokenAccountOwners(block);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      tokenAccountAddress: "token-account",
      ownerAddress: "owner",
      mint: "mint",
    });
    expect(result[0]?.rawObjectHash).toMatch(/^sha256:/);
  });

  it("ignores balances that do not contain an owner", () => {
    const block = {
      chain: "solana",
      sequence: "1",
      providerRef: "block-1",
      sourceTimestamp: "2026-10-05T00:00:00.000Z",
      payload: {
        transactions: [
          {
            meta: { preTokenBalances: [{ accountIndex: 0, mint: "mint" }] },
            transaction: { message: { accountKeys: ["token-account"] } },
          },
        ],
      },
    } as RawBlock;
    expect(extractSolanaTokenAccountOwners(block)).toEqual([]);
  });
});
