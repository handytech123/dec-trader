import { fileURLToPath } from "node:url";
import {
  HttpJsonRpcTransport,
  SolanaChainProvider,
} from "@autonomous-trading-lab/solana-chain-provider";
import type { RawBlock } from "@autonomous-trading-lab/provider-sdk";
import { ResearchDatabase } from "./database.js";
import { databaseLocation } from "./database-location.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function blockSignatures(block: RawBlock): ReadonlySet<string> {
  if (
    typeof block.payload !== "object" ||
    block.payload === null ||
    !("transactions" in block.payload)
  )
    return new Set();
  const transactions = (block.payload as { transactions?: unknown }).transactions;
  if (!Array.isArray(transactions)) return new Set();
  const signatures = new Set<string>();
  for (const item of transactions) {
    if (typeof item !== "object" || item === null || !("transaction" in item)) continue;
    const transaction = (item as { transaction?: unknown }).transaction;
    if (typeof transaction !== "object" || transaction === null || !("signatures" in transaction))
      continue;
    const values = (transaction as { signatures?: unknown }).signatures;
    if (Array.isArray(values)) {
      for (const value of values) if (typeof value === "string") signatures.add(value);
    }
  }
  return signatures;
}

async function main(): Promise<void> {
  if (!process.argv.includes("--enable-read-only-reconciliation"))
    throw new Error(
      "reconciliation is disabled; pass --enable-read-only-reconciliation explicitly",
    );
  const normalizationOnly = process.argv.includes("--normalization-only");
  const endpoint = option("--rpc-endpoint") ?? process.env.CFIE_SOLANA_RPC_URL;
  if (!normalizationOnly && !endpoint) throw new Error("a finalized RPC endpoint is required");
  const limit = Number(option("--limit") ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
    throw new Error("--limit must be between 1 and 10000");
  const maximumParallelBlocks = Number(option("--max-parallel-blocks") ?? 1);
  if (
    !Number.isInteger(maximumParallelBlocks) ||
    maximumParallelBlocks < 1 ||
    maximumParallelBlocks > 20
  )
    throw new Error("--max-parallel-blocks must be between 1 and 20");
  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  const databasePath = databaseLocation(
    invocationDirectory,
    process.env.CFIE_DATABASE_URL ?? requiredOption("--database"),
  );
  const database = new ResearchDatabase(databasePath);
  const provider = endpoint
    ? new SolanaChainProvider(new HttpJsonRpcTransport(endpoint))
    : undefined;
  const canonicalStorage = database.chainCollectionStorage();
  let finalized = 0;
  let missing = 0;
  let failed = 0;
  try {
    await database.migrate(
      fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
    );
    // Link already-normalized finalized blocks first. This is database-only and must not be
    // starved behind a slow or rate-limited RPC reconciliation backlog.
    const normalized = await database.linkExistingFinalizedFilteredTransactions(limit);
    if (normalizationOnly) {
      process.stdout.write(
        `${JSON.stringify({ mode: "READ_ONLY_FILTERED_NORMALIZATION_LINK", normalized })}\n`,
      );
      return;
    }
    const pending = await database.pendingFilteredTransactions(limit);
    const recordsBySlot = new Map<string, typeof pending>();
    for (const record of pending)
      recordsBySlot.set(record.slot, [...(recordsBySlot.get(record.slot) ?? []), record]);
    const slotGroups = [...recordsBySlot.entries()];
    const reconcileSlot = async ([, records]: (typeof slotGroups)[number]): Promise<void> => {
      try {
        if (!provider) throw new Error("a finalized RPC endpoint is required");
        const block = await provider.getBlock(records[0]?.slot ?? "");
        const signatures = blockSignatures(block);
        if (records.some((record) => signatures.has(record.signature)))
          await canonicalStorage.append(block);
        // Store the finalized canonical block, not the confirmed WebSocket projection. The
        // existing normalization queue then creates exactly the same event identities and
        // evidence as the full-block collector, even when this faster path arrives first.
        for (const record of records) {
          try {
            const isPresent = signatures.has(record.signature);
            await database.persistFilteredTransactionReconciliation({
              providerId: record.providerId,
              filterId: record.filterId,
              signature: record.signature,
              status: isPresent ? "FINALIZED" : "MISSING",
              reconciledAt: new Date().toISOString(),
              ...(isPresent
                ? { finalizedBlockHash: block.providerRef }
                : { detail: "signature absent from finalized block" }),
            });
            if (isPresent) finalized += 1;
            else missing += 1;
          } catch {
            failed += 1;
          }
        }
      } catch {
        // RPC availability is not evidence about transaction finality. Leave the record pending so
        // a later bounded run can retry it rather than publishing a false terminal conclusion.
        failed += records.length;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(maximumParallelBlocks, slotGroups.length) }, async () => {
        for (;;) {
          const group = slotGroups.shift();
          if (!group) return;
          await reconcileSlot(group);
        }
      }),
    );
    process.stdout.write(
      `${JSON.stringify({ mode: "READ_ONLY_FINALIZED_RECONCILIATION", examined: pending.length, finalized, missing, failed, normalized, maximumParallelBlocks })}\n`,
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
