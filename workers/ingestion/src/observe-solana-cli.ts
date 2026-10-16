import { resolve } from "node:path";
import {
  HttpJsonRpcTransport,
  SolanaChainProvider,
} from "@autonomous-trading-lab/solana-chain-provider";
import { ResearchDatabase } from "./database.js";
import { databaseDisplayLocation, databaseLocation } from "./database-location.js";
import { runBoundedSolanaObservation } from "./observation.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredInteger(name: string, minimum: number, maximum: number): number {
  const value = Number(requiredOption(name));
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer between ${String(minimum)} and ${String(maximum)}`);
  return value;
}

async function main(): Promise<void> {
  if (!process.argv.includes("--enable-read-only-observation"))
    throw new Error("observation is disabled; pass --enable-read-only-observation explicitly");
  const rpcEndpoint = option("--rpc-endpoint") ?? process.env.CFIE_SOLANA_RPC_URL;
  if (!rpcEndpoint)
    throw new Error("--rpc-endpoint or the CFIE_SOLANA_RPC_URL environment variable is required");
  const initialSlot = requiredInteger("--initial-slot", 0, Number.MAX_SAFE_INTEGER);
  const maximumBatchSlots = requiredInteger("--max-batch-slots", 1, 500);
  const maximumPolls = requiredInteger("--max-polls", 1, 10_000);
  const pollIntervalMs = requiredInteger("--poll-interval-ms", 250, 60_000);
  const maximumConsecutiveFailures = requiredInteger("--max-consecutive-failures", 0, 20);
  const failureBackoffMs = requiredInteger("--failure-backoff-ms", 250, 60_000);
  const maximumDurationSeconds = requiredInteger("--max-duration-seconds", 1, 3600);
  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  const databasePath = databaseLocation(
    invocationDirectory,
    process.env.CFIE_DATABASE_URL ?? requiredOption("--database"),
  );
  const migrationsPath = resolve(invocationDirectory, "infra/postgres/migrations");
  const database = new ResearchDatabase(databasePath);
  try {
    await database.migrate(migrationsPath);
    const provider = new SolanaChainProvider(new HttpJsonRpcTransport(rpcEndpoint));
    const result = await runBoundedSolanaObservation(
      provider,
      database,
      {
        initialSlot,
        maximumBatchSlots,
        maximumPolls,
        pollIntervalMs,
        maximumConsecutiveFailures,
        failureBackoffMs,
      },
      AbortSignal.timeout(maximumDurationSeconds * 1000),
    );
    process.stdout.write(
      `${JSON.stringify({
        mode: "READ_ONLY_OBSERVATION",
        chain: "solana",
        limits: {
          maximumBatchSlots,
          maximumPolls,
          pollIntervalMs,
          maximumConsecutiveFailures,
          failureBackoffMs,
          maximumDurationSeconds,
        },
        databasePath: databaseDisplayLocation(databasePath),
        result,
      })}\n`,
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
