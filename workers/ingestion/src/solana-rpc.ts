import {
  inspectMintAccount,
  type TokenSafetyAssessment,
} from "@autonomous-trading-lab/token-safety";
import { z } from "zod";

const AccountSchema = z.object({
  data: z.tuple([z.string(), z.literal("base64")]),
  owner: z.string(),
});
const RpcSchema = z.object({
  result: z.object({
    context: z.object({ slot: z.number().int().nonnegative() }),
    value: z.array(AccountSchema.nullable()),
  }),
});

export interface RpcMintAssessment {
  readonly mint: string;
  readonly slot: number;
  readonly assessment: TokenSafetyAssessment;
}

export async function inspectMints(
  mints: readonly string[],
  endpoint = "https://api.mainnet-beta.solana.com",
): Promise<readonly RpcMintAssessment[]> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [mints, { encoding: "base64", commitment: "finalized" }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Solana RPC HTTP ${String(response.status)}`);
  const parsed = RpcSchema.parse(await response.json());
  return parsed.result.value.flatMap((account, index) => {
    // index originates from the validated RPC array and is bounds-checked below.
    // eslint-disable-next-line security/detect-object-injection
    const mint = mints[index];
    if (!account || !mint) return [];
    return [
      {
        mint,
        slot: parsed.result.context.slot,
        assessment: inspectMintAccount(Buffer.from(account.data[0], "base64"), account.owner),
      },
    ];
  });
}
