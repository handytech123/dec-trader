import { z } from "zod";

const SlotSchema = z.number().int().nonnegative();
const SignatureSchema = z.string().min(32).max(128);

const LegacyFilteredTransactionResultSchema = z
  .object({
    context: z.object({ slot: SlotSchema }).loose(),
    value: z
      .object({
        signature: SignatureSchema,
        transaction: z.unknown(),
        meta: z.unknown().nullable().optional(),
      })
      .loose(),
  })
  .loose();

const CurrentFilteredTransactionResultSchema = z
  .object({
    slot: SlotSchema,
    signature: SignatureSchema,
    transaction: z.unknown(),
  })
  .loose();

export const FilteredTransactionNotificationSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.literal("transactionNotification"),
    params: z
      .object({
        subscription: z.number().int().nonnegative(),
        result: z.union([
          LegacyFilteredTransactionResultSchema,
          CurrentFilteredTransactionResultSchema,
        ]),
      })
      .loose(),
  })
  .loose();

export type FilteredTransactionNotification = z.infer<typeof FilteredTransactionNotificationSchema>;

export interface FilteredTransactionFilter {
  readonly filterId: string;
  readonly accountInclude: readonly string[];
  readonly accountExclude?: readonly string[];
  readonly accountRequired?: readonly string[];
}

export interface FilteredTransactionRecord {
  readonly providerId: string;
  readonly filterId: string;
  readonly subscriptionId: number;
  readonly slot: string;
  readonly signature: string;
  readonly receivedAt: string;
  readonly commitment: "confirmed";
  readonly parserVersion: number;
  readonly payload: unknown;
}

const checkedAddresses = (addresses: readonly string[], name: string): readonly string[] => {
  if (addresses.length === 0 && name === "accountInclude")
    throw new Error("accountInclude cannot be empty");
  if (addresses.length > 50_000) throw new Error(`${name} exceeds provider maximum`);
  const unique = [...new Set(addresses)];
  if (unique.length !== addresses.length) throw new Error(`${name} contains duplicates`);
  for (const address of unique) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))
      throw new Error(`${name} contains an invalid Solana address`);
  }
  return unique;
};

export function transactionSubscribeRequest(
  filter: FilteredTransactionFilter,
  requestId = 1,
): unknown {
  if (!filter.filterId.trim()) throw new Error("filterId is required");
  const accountInclude = checkedAddresses(filter.accountInclude, "accountInclude");
  const accountExclude =
    filter.accountExclude === undefined
      ? undefined
      : checkedAddresses(filter.accountExclude, "accountExclude");
  const accountRequired =
    filter.accountRequired === undefined
      ? undefined
      : checkedAddresses(filter.accountRequired, "accountRequired");
  return {
    jsonrpc: "2.0",
    id: requestId,
    method: "transactionSubscribe",
    params: [
      {
        failed: false,
        vote: false,
        accountInclude,
        ...(accountExclude === undefined ? {} : { accountExclude }),
        ...(accountRequired === undefined ? {} : { accountRequired }),
      },
      {
        commitment: "confirmed",
        encoding: "jsonParsed",
        transactionDetails: "full",
        maxSupportedTransactionVersion: 1,
      },
    ],
  };
}

export function parseFilteredTransaction(
  payload: unknown,
  metadata: {
    readonly providerId: string;
    readonly filterId: string;
    readonly receivedAt: string;
    readonly parserVersion?: number;
  },
): FilteredTransactionRecord {
  const notification = FilteredTransactionNotificationSchema.parse(payload);
  const result = notification.params.result;
  const legacy = LegacyFilteredTransactionResultSchema.safeParse(result);
  const identity = legacy.success
    ? { slot: legacy.data.context.slot, signature: legacy.data.value.signature }
    : (() => {
        const current = CurrentFilteredTransactionResultSchema.parse(result);
        return { slot: current.slot, signature: current.signature };
      })();
  return {
    providerId: metadata.providerId,
    filterId: metadata.filterId,
    subscriptionId: notification.params.subscription,
    slot: String(identity.slot),
    signature: identity.signature,
    receivedAt: metadata.receivedAt,
    commitment: "confirmed",
    parserVersion: metadata.parserVersion ?? 1,
    payload,
  };
}
