import { z } from "zod";
import { contentHash } from "@autonomous-trading-lab/domain";
import type { RawBlock } from "@autonomous-trading-lab/provider-sdk";

const PayloadSchema = z
  .object({
    transactions: z.array(
      z
        .object({
          meta: z
            .object({
              preTokenBalances: z
                .array(
                  z
                    .object({
                      accountIndex: z.number().int().nonnegative(),
                      mint: z.string(),
                      owner: z.string().optional(),
                    })
                    .loose(),
                )
                .nullish(),
              postTokenBalances: z
                .array(
                  z
                    .object({
                      accountIndex: z.number().int().nonnegative(),
                      mint: z.string(),
                      owner: z.string().optional(),
                    })
                    .loose(),
                )
                .nullish(),
              innerInstructions: z
                .array(z.object({ instructions: z.array(z.unknown()) }).loose())
                .nullish(),
            })
            .loose(),
          transaction: z
            .object({
              message: z
                .object({
                  accountKeys: z
                    .array(z.union([z.string(), z.object({ pubkey: z.string() }).loose()]))
                    .optional(),
                  instructions: z.array(z.unknown()).optional(),
                })
                .loose(),
            })
            .loose(),
        })
        .loose(),
    ),
  })
  .loose();

export interface SolanaTokenAccountOwnerObservation {
  readonly tokenAccountAddress: string;
  readonly ownerAddress: string;
  readonly mint: string;
  readonly observedAt: string;
  readonly rawObjectHash: `sha256:${string}`;
}

export function extractSolanaTokenAccountOwners(
  block: RawBlock,
): readonly SolanaTokenAccountOwnerObservation[] {
  if (block.chain !== "solana") throw new Error("expected a Solana block");
  const payload = PayloadSchema.parse(block.payload);
  const rawObjectHash = contentHash(block);
  const observations = new Map<string, SolanaTokenAccountOwnerObservation>();
  for (const transaction of payload.transactions) {
    const accountKeys = (transaction.transaction.message.accountKeys ?? []).map((account) =>
      typeof account === "string" ? account : account.pubkey,
    );
    const transferAccounts = new Set<string>();
    const instructions = [
      ...(transaction.transaction.message.instructions ?? []),
      ...(transaction.meta.innerInstructions ?? []).flatMap((group) => group.instructions),
    ];
    for (const instruction of instructions) {
      const parsed = z
        .object({
          program: z.enum(["spl-token", "spl-token-2022"]),
          parsed: z.object({
            type: z.enum(["transfer", "transferChecked", "transferCheckedWithFee"]),
            info: z.object({ source: z.string(), destination: z.string() }).loose(),
          }),
        })
        .loose()
        .safeParse(instruction);
      if (!parsed.success) continue;
      transferAccounts.add(parsed.data.parsed.info.source);
      transferAccounts.add(parsed.data.parsed.info.destination);
    }
    for (const balance of [
      ...(transaction.meta.preTokenBalances ?? []),
      ...(transaction.meta.postTokenBalances ?? []),
    ]) {
      const tokenAccountAddress = accountKeys[balance.accountIndex];
      if (!tokenAccountAddress || !balance.owner || !transferAccounts.has(tokenAccountAddress))
        continue;
      const observation = {
        tokenAccountAddress,
        ownerAddress: balance.owner,
        mint: balance.mint,
        observedAt: block.sourceTimestamp,
        rawObjectHash,
      };
      observations.set(`${tokenAccountAddress}:${balance.owner}:${balance.mint}`, observation);
    }
  }
  return [...observations.values()].sort(
    (left, right) =>
      left.tokenAccountAddress.localeCompare(right.tokenAccountAddress) ||
      left.ownerAddress.localeCompare(right.ownerAddress) ||
      left.mint.localeCompare(right.mint),
  );
}
