import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { RawBlock } from "@autonomous-trading-lab/provider-sdk";
import { normalizeSolanaTransfers } from "../src/index.js";

const fixturePath = new URL("../fixtures/parsed-transfer-block.json", import.meta.url);

async function fixture(): Promise<RawBlock> {
  // Test-local URL is a constant under the package fixture directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return JSON.parse(await readFile(fixturePath, "utf8")) as RawBlock;
}

describe("Solana transfer normalization", () => {
  it("normalizes native and inner SPL transfers with raw provenance", async () => {
    const batch = normalizeSolanaTransfers(await fixture(), "2026-01-01T00:00:01.000Z");
    expect(batch.events).toHaveLength(2);
    expect(batch.events.map((event) => event.quantity).sort()).toEqual(["1.25", "2.5"]);
    expect(batch.events.every((event) => event.usdValueAtEvent === null)).toBe(true);
    expect(batch.events.every((event) => event.rawRef === batch.provenance.rawObjectRef)).toBe(
      true,
    );
    expect(batch.ignoredInstructionCount).toBe(1);
    expect(batch.failedTransactionCount).toBe(1);
  });

  it("is deterministic across identical replay", async () => {
    const block = await fixture();
    expect(normalizeSolanaTransfers(block, "2026-01-01T00:00:01.000Z")).toEqual(
      normalizeSolanaTransfers(structuredClone(block), "2026-01-01T00:00:01.000Z"),
    );
  });

  it("preserves the invoking program for inner transfers", async () => {
    const base = await fixture();
    const invokingProgram = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
    const payload = structuredClone(base.payload) as {
      transactions: {
        meta: { innerInstructions?: { index: number; instructions: unknown[] }[] | null };
        transaction: { message: { instructions: unknown[] } };
      }[];
    };
    const transaction = payload.transactions[1];
    if (!transaction) throw new Error("fixture unexpectedly contains no transaction");
    const innerTransfer = transaction.meta.innerInstructions?.[0]?.instructions[0];
    if (innerTransfer === undefined) throw new Error("fixture unexpectedly has no inner transfer");
    transaction.transaction.message.instructions = [
      { programId: invokingProgram, accounts: [], data: "opaque-program-instruction" },
    ];
    transaction.meta.innerInstructions = [{ index: 0, instructions: [innerTransfer] }];
    payload.transactions = [transaction];

    const batch = normalizeSolanaTransfers({ ...base, payload }, "2026-01-01T00:00:01.000Z");
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]?.venue).toBe(invokingProgram);
  });

  it("rejects another chain and missing block time", async () => {
    const block = await fixture();
    expect(() =>
      normalizeSolanaTransfers({ ...block, chain: "ethereum" }, "2026-01-01T00:00:01.000Z"),
    ).toThrow(/Solana/);
    expect(() =>
      normalizeSolanaTransfers(
        { ...block, sourceTimestamp: "1970-01-01T00:00:00.000Z" },
        "2026-01-01T00:00:01.000Z",
      ),
    ).toThrow(/block time/);
  });

  it("normalizes legacy SPL and Token-2022 checked variants without guessing mint identity", async () => {
    const source = "LegacySource111111111111111111111111111111";
    const destination = "LegacyDest11111111111111111111111111111111";
    const base = await fixture();
    const withVariants: RawBlock = {
      ...base,
      payload: {
        transactions: [
          {
            meta: {
              err: null,
              preTokenBalances: [
                {
                  accountIndex: 0,
                  mint: "LegacyMint11111111111111111111111111111111",
                  uiTokenAmount: { amount: "1000", decimals: 2 },
                },
              ],
              postTokenBalances: [],
            },
            transaction: {
              signatures: ["legacy-signature"],
              message: {
                accountKeys: [{ pubkey: source }, { pubkey: destination }],
                instructions: [
                  {
                    program: "spl-token",
                    parsed: {
                      type: "transfer",
                      info: { source, destination, amount: "250" },
                    },
                  },
                  {
                    program: "spl-token",
                    programId: "Token2022Program",
                    parsed: {
                      type: "transferCheckedWithFee",
                      info: {
                        source,
                        destination,
                        mint: "Token2022Mint111111111111111111111111111111",
                        tokenAmount: { amount: "5000", decimals: 3 },
                      },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    };
    const batch = normalizeSolanaTransfers(withVariants, "2026-01-01T00:00:01.000Z");
    expect(batch.events.map((event) => event.quantity).sort()).toEqual(["2.5", "5"]);
  });

  it("resolves legacy SPL balances against address-lookup-table account keys", async () => {
    const base = await fixture();
    const source = "LookupSource111111111111111111111111111111";
    const destination = "LookupDest11111111111111111111111111111111";
    const block: RawBlock = {
      ...base,
      payload: {
        transactions: [
          {
            meta: {
              err: null,
              preTokenBalances: [
                {
                  accountIndex: 1,
                  mint: "LookupMint11111111111111111111111111111111",
                  uiTokenAmount: { amount: "4200", decimals: 2 },
                },
              ],
              postTokenBalances: [],
            },
            transaction: {
              signatures: ["lookup-table-signature"],
              message: {
                accountKeys: [
                  { pubkey: "Payer11111111111111111111111111111111111", source: "transaction" },
                  { pubkey: source, source: "lookupTable" },
                  { pubkey: destination, source: "lookupTable" },
                ],
                instructions: [
                  {
                    program: "spl-token",
                    parsed: {
                      type: "transfer",
                      info: { source, destination, amount: "1250" },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    };
    const batch = normalizeSolanaTransfers(block, "2026-01-01T00:00:01.000Z");
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]?.quantity).toBe("12.5");
  });

  it("attributes SPL transfers to token-account owners when RPC balances provide them", async () => {
    const base = await fixture();
    const source = "SourceTokenAccount11111111111111111111111111";
    const destination = "DestinationTokenAccount111111111111111111111";
    const sourceOwner = "SourceOwner11111111111111111111111111111111";
    const destinationOwner = "DestinationOwner111111111111111111111111111";
    const block: RawBlock = {
      ...base,
      payload: {
        transactions: [
          {
            meta: {
              err: null,
              preTokenBalances: [
                {
                  accountIndex: 0,
                  mint: "Mint111111111111111111111111111111111111111",
                  owner: sourceOwner,
                  uiTokenAmount: { amount: "100", decimals: 2 },
                },
                {
                  accountIndex: 1,
                  mint: "Mint111111111111111111111111111111111111111",
                  owner: destinationOwner,
                  uiTokenAmount: { amount: "0", decimals: 2 },
                },
              ],
              postTokenBalances: [],
            },
            transaction: {
              signatures: ["owner-aware-signature"],
              message: {
                accountKeys: [{ pubkey: source }, { pubkey: destination }],
                instructions: [
                  {
                    program: "spl-token",
                    parsed: {
                      type: "transfer",
                      info: { source, destination, amount: "25" },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    };
    const batch = normalizeSolanaTransfers(block, "2026-01-01T00:00:01.000Z");
    expect(batch.entities.map((entity) => entity.addresses[0]).sort()).toEqual(
      [destinationOwner, sourceOwner].sort(),
    );
    expect(batch.entities.some((entity) => entity.addresses.includes(source))).toBe(false);
    expect(batch.events[0]?.fromEntityId).toBe(
      batch.entities.find((entity) => entity.addresses.includes(sourceOwner))?.entityId,
    );
  });

  it("ignores an unresolvable token balance mapping rather than guessing", async () => {
    const base = await fixture();
    const payload = structuredClone(base.payload) as {
      transactions: {
        meta: {
          innerInstructions?: unknown[] | null;
          preTokenBalances?: {
            accountIndex: number;
            mint: string;
            uiTokenAmount: { amount: string; decimals: number };
          }[];
        };
        transaction: { message: { instructions: unknown[] } };
      }[];
    };
    const transaction = payload.transactions[0];
    if (!transaction) throw new Error("fixture unexpectedly contains no transaction");
    transaction.meta.preTokenBalances = [
      {
        accountIndex: 999,
        mint: "UnresolvedMint111111111111111111111111111111",
        uiTokenAmount: { amount: "10", decimals: 0 },
      },
    ];
    transaction.meta.innerInstructions = [];
    payload.transactions = [transaction];
    transaction.transaction.message.instructions = [
      {
        program: "spl-token",
        parsed: {
          type: "transfer",
          info: { source: "UnknownSource", destination: "UnknownDestination", amount: "10" },
        },
      },
    ];
    const batch = normalizeSolanaTransfers({ ...base, payload }, "2026-01-01T00:00:01.000Z");
    expect(batch.events).toHaveLength(0);
    expect(batch.ignoredInstructionCount).toBeGreaterThan(0);
  });

  it("fails closed for unsupported Token-2022 instructions", async () => {
    const base = await fixture();
    const block: RawBlock = {
      ...base,
      payload: {
        transactions: [
          {
            meta: { err: null, preTokenBalances: [], postTokenBalances: [] },
            transaction: {
              signatures: ["unsupported-token-2022-signature"],
              message: {
                accountKeys: [],
                instructions: [
                  {
                    program: "spl-token",
                    programId: "Token2022Program",
                    parsed: {
                      type: "confidentialTransfer",
                      info: { source: "source", destination: "destination", amount: "999" },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    };
    const batch = normalizeSolanaTransfers(block, "2026-01-01T00:00:01.000Z");
    expect(batch.events).toHaveLength(0);
    expect(batch.ignoredInstructionCount).toBe(1);
  });

  it("rejects unsafe Token-2022 decimal precision", async () => {
    const base = await fixture();
    const block: RawBlock = {
      ...base,
      payload: {
        transactions: [
          {
            meta: { err: null, preTokenBalances: [], postTokenBalances: [] },
            transaction: {
              signatures: ["unsafe-decimals-signature"],
              message: {
                accountKeys: [],
                instructions: [
                  {
                    program: "spl-token",
                    programId: "Token2022Program",
                    parsed: {
                      type: "transferChecked",
                      info: {
                        source: "source",
                        destination: "destination",
                        mint: "mint",
                        tokenAmount: { amount: "1", decimals: 19 },
                      },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    };
    expect(() => normalizeSolanaTransfers(block, "2026-01-01T00:00:01.000Z")).toThrow(
      /decimals must be between 0 and 18/,
    );
  });
});
