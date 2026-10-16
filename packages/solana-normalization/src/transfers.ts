import { z } from "zod";
import {
  CapitalEventSchema,
  EntitySchema,
  ProvenanceSchema,
  type CapitalEvent,
  type Entity,
  type Provenance,
} from "@autonomous-trading-lab/capital-flow";
import { contentHash, deterministicDomainId } from "@autonomous-trading-lab/domain";
import type { RawBlock } from "@autonomous-trading-lab/provider-sdk";

const ParsedInstructionSchema = z
  .object({
    program: z.string(),
    programId: z.string().optional(),
    parsed: z.object({ type: z.string(), info: z.record(z.string(), z.unknown()) }),
  })
  .loose();
const TransactionSchema = z
  .object({
    meta: z
      .object({
        err: z.unknown().nullable(),
        innerInstructions: z
          .array(
            z
              .object({
                index: z.number().int().nonnegative(),
                instructions: z.array(z.unknown()),
              })
              .loose(),
          )
          .nullable()
          .optional(),
        preTokenBalances: z
          .array(
            z
              .object({
                accountIndex: z.number().int().nonnegative(),
                mint: z.string(),
                owner: z.string().optional(),
                uiTokenAmount: z.object({ amount: z.string(), decimals: z.number().int() }).loose(),
              })
              .loose(),
          )
          .nullable()
          .optional(),
        postTokenBalances: z
          .array(
            z
              .object({
                accountIndex: z.number().int().nonnegative(),
                mint: z.string(),
                owner: z.string().optional(),
                uiTokenAmount: z.object({ amount: z.string(), decimals: z.number().int() }).loose(),
              })
              .loose(),
          )
          .nullable()
          .optional(),
      })
      .loose(),
    transaction: z
      .object({
        signatures: z.array(z.string()).min(1),
        message: z
          .object({
            instructions: z.array(z.unknown()),
            accountKeys: z
              .array(z.union([z.string(), z.object({ pubkey: z.string() }).loose()]))
              .optional(),
          })
          .loose(),
      })
      .loose(),
  })
  .loose();
const BlockPayloadSchema = z.object({ transactions: z.array(TransactionSchema) }).loose();

export interface NormalizedCapitalBatch {
  readonly provenance: Provenance;
  readonly assets: readonly NormalizedCapitalAsset[];
  readonly entities: readonly Entity[];
  readonly events: readonly CapitalEvent[];
  readonly ignoredInstructionCount: number;
  readonly failedTransactionCount: number;
}

export interface NormalizedCapitalAsset {
  readonly assetId: string;
  readonly chain: "solana";
  readonly mint: string;
  readonly tokenProgram: string;
  readonly decimals: number;
  readonly metadataStatus: "UNRESOLVED";
  readonly firstObservedAt: string;
}

interface NormalizedTransfer {
  readonly event: CapitalEvent;
  readonly asset: NormalizedCapitalAsset;
  readonly entities: readonly [Entity, Entity];
}

const addressEntityId = (address: string): string =>
  deterministicDomainId("entity", `solana:address:${address}`);

function decimalFromAtomic(amount: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(amount)) throw new Error("token amount must be atomic units");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
    throw new Error("token decimals must be between 0 and 18");
  if (decimals === 0) return amount;
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

function normalizedInstruction(
  instruction: unknown,
  transactionSignature: string,
  instructionIndex: number,
  rawRef: `sha256:${string}`,
  block: RawBlock,
  ingestedAt: string,
  tokenByAccount: ReadonlyMap<
    string,
    { readonly mint: string; readonly decimals: number; readonly owner?: string }
  >,
  invokedBy?: string,
): NormalizedTransfer | undefined {
  const parsed = ParsedInstructionSchema.safeParse(instruction);
  if (!parsed.success) return undefined;
  const { program, parsed: body } = parsed.data;
  const info = body.info;
  let source: string;
  let destination: string;
  let assetSeed: string;
  let mint: string;
  let tokenProgram: string;
  let decimals: number;
  let quantity: string;

  if (program === "system" && body.type === "transfer") {
    source = z.string().parse(info.source);
    destination = z.string().parse(info.destination);
    const lamports = z.union([z.string(), z.number().int().nonnegative()]).parse(info.lamports);
    decimals = 9;
    quantity = decimalFromAtomic(lamports.toString(), decimals);
    assetSeed = "solana:native:SOL";
    mint = "native:SOL";
    tokenProgram = "system";
  } else if (
    (program === "spl-token" || program === "spl-token-2022") &&
    (body.type === "transferChecked" || body.type === "transferCheckedWithFee")
  ) {
    source = z.string().parse(info.source);
    destination = z.string().parse(info.destination);
    mint = z.string().parse(info.mint);
    const tokenAmount = z
      .object({ amount: z.string(), decimals: z.number().int() })
      .parse(info.tokenAmount);
    decimals = tokenAmount.decimals;
    quantity = decimalFromAtomic(tokenAmount.amount, decimals);
    assetSeed = `solana:spl:${mint}`;
    tokenProgram = parsed.data.programId ?? program;
  } else if (
    (program === "spl-token" || program === "spl-token-2022") &&
    body.type === "transfer"
  ) {
    source = z.string().parse(info.source);
    destination = z.string().parse(info.destination);
    const token = tokenByAccount.get(source) ?? tokenByAccount.get(destination);
    if (!token) return undefined;
    const amount = z.union([z.string(), z.number().int().nonnegative()]).parse(info.amount);
    decimals = token.decimals;
    mint = token.mint;
    quantity = decimalFromAtomic(amount.toString(), decimals);
    assetSeed = `solana:spl:${mint}`;
    tokenProgram = parsed.data.programId ?? program;
  } else {
    return undefined;
  }

  const sourceEntityAddress = tokenByAccount.get(source)?.owner ?? source;
  const destinationEntityAddress = tokenByAccount.get(destination)?.owner ?? destination;

  const eventIdentity = `${transactionSignature}:${String(instructionIndex)}:${source}:${destination}`;
  const event = CapitalEventSchema.parse({
    eventId: deterministicDomainId("event", eventIdentity),
    eventTime: block.sourceTimestamp,
    ingestTime: ingestedAt,
    source: "solana-rpc-json-parsed",
    chain: "solana",
    ...(invokedBy === undefined ? {} : { venue: invokedBy }),
    eventType: "TRANSFER",
    assetId: deterministicDomainId("asset", assetSeed),
    quantity,
    usdValueAtEvent: null,
    fromEntityId: addressEntityId(sourceEntityAddress),
    toEntityId: addressEntityId(destinationEntityAddress),
    transactionHash: transactionSignature,
    confidence: 1,
    rawRef,
    schemaVersion: "1",
  });
  const evidence = {
    source: "solana-rpc",
    rawRef,
    observedAt: block.sourceTimestamp,
    method: "VERIFIED" as const,
  };
  const entity = (address: string): Entity =>
    EntitySchema.parse({
      entityId: addressEntityId(address),
      entityType: "ADDRESS",
      labels: [],
      addresses: [address],
      attribution: "UNKNOWN",
      confidence: 1,
      firstSeen: block.sourceTimestamp,
      lastSeen: block.sourceTimestamp,
      evidence: [evidence],
      schemaVersion: "1",
    });
  return {
    event,
    asset: {
      assetId: event.assetId,
      chain: "solana",
      mint,
      tokenProgram,
      decimals,
      metadataStatus: "UNRESOLVED",
      firstObservedAt: block.sourceTimestamp,
    },
    entities: [entity(sourceEntityAddress), entity(destinationEntityAddress)],
  };
}

export function normalizeSolanaTransfers(
  block: RawBlock,
  ingestedAt: string,
  parserVersion = "3",
): NormalizedCapitalBatch {
  if (block.chain !== "solana") throw new Error("expected a Solana raw block");
  if (block.sourceTimestamp === new Date(0).toISOString())
    throw new Error("block time is required for capital-event normalization");
  const payload = BlockPayloadSchema.parse(block.payload);
  const rawRef = contentHash(block);
  const provenance = ProvenanceSchema.parse({
    sourceProvider: "solana-rpc",
    sourceType: "CHAIN",
    sourceId: block.providerRef,
    observedAt: block.sourceTimestamp,
    ingestedAt,
    rawObjectRef: rawRef,
    schemaVersion: "1",
    parserVersion,
  });
  const events: CapitalEvent[] = [];
  const assets = new Map<string, NormalizedCapitalAsset>();
  const entities = new Map<string, Entity>();
  let ignoredInstructionCount = 0;
  let failedTransactionCount = 0;
  for (const transaction of payload.transactions) {
    if (transaction.meta.err !== null) {
      failedTransactionCount += 1;
      continue;
    }
    const topLevelInstructions = transaction.transaction.message.instructions;
    const instructions: { instruction: unknown; invokedBy?: string }[] = [
      ...topLevelInstructions.map((instruction) => ({ instruction })),
      ...(transaction.meta.innerInstructions ?? []).flatMap((item) => {
        const parent = z
          .object({ programId: z.string().min(1).optional() })
          .loose()
          .safeParse(topLevelInstructions[item.index]);
        const invokedBy =
          Number(parserVersion) >= 2 && parent.success ? parent.data.programId : undefined;
        return item.instructions.map((instruction) => ({
          instruction,
          ...(invokedBy === undefined ? {} : { invokedBy }),
        }));
      }),
    ];
    const accountKeys = (transaction.transaction.message.accountKeys ?? []).map((account) =>
      typeof account === "string" ? account : account.pubkey,
    );
    const tokenByAccount = new Map<string, { mint: string; decimals: number; owner?: string }>();
    for (const balance of [
      ...(transaction.meta.preTokenBalances ?? []),
      ...(transaction.meta.postTokenBalances ?? []),
    ]) {
      const account = accountKeys[balance.accountIndex];
      if (account)
        tokenByAccount.set(account, {
          mint: balance.mint,
          decimals: balance.uiTokenAmount.decimals,
          ...(balance.owner === undefined ? {} : { owner: balance.owner }),
        });
    }
    const signature = transaction.transaction.signatures[0];
    if (!signature) throw new Error("transaction signature unexpectedly missing");
    for (const [index, context] of instructions.entries()) {
      const transfer = normalizedInstruction(
        context.instruction,
        signature,
        index,
        rawRef,
        block,
        ingestedAt,
        tokenByAccount,
        context.invokedBy,
      );
      if (transfer) {
        events.push(transfer.event);
        assets.set(transfer.asset.assetId, transfer.asset);
        for (const entity of transfer.entities) entities.set(entity.entityId, entity);
      } else ignoredInstructionCount += 1;
    }
  }
  return {
    provenance,
    assets: [...assets.values()].sort((left, right) => left.assetId.localeCompare(right.assetId)),
    entities: [...entities.values()].sort((left, right) =>
      left.entityId.localeCompare(right.entityId),
    ),
    events: events.sort((left, right) => left.eventId.localeCompare(right.eventId)),
    ignoredInstructionCount,
    failedTransactionCount,
  };
}
