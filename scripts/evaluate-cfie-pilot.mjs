import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function requiredOption(name) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerOption(name, fallback, minimum = 0) {
  const candidate = option(name);
  if (candidate === undefined) return fallback;
  const value = Number(candidate);
  if (!Number.isInteger(value) || value < minimum)
    throw new Error(`${name} must be an integer of at least ${minimum}`);
  return value;
}

function object(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} is missing or invalid`);
  return value;
}

function number(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${label} is missing or invalid`);
  return value;
}

async function main() {
  const manifestPath = resolve(process.cwd(), requiredOption("--manifest"));
  const report = object(JSON.parse(await readFile(manifestPath, "utf8")), "pilot report");
  if (report.mode !== "READ_ONLY_OBSERVATION")
    throw new Error("manifest is not a CFIE pilot report");
  if (report.authority !== "NO_WALLET_NO_SIGNING_NO_SUBMISSION_NO_ORDERS")
    throw new Error("manifest does not contain the read-only authority boundary");

  const solana = object(report.solana, "solana result");
  const capture = object(solana.capture, "solana capture");
  const queue = object(solana.queueAfterNormalization, "normalization queue");
  const coinbase = object(report.coinbase, "coinbase result");
  const coinbaseResult = object(coinbase.result, "coinbase observation");
  const thresholds = {
    minimumCompletedBatches: integerOption("--min-solana-batches", 1),
    maximumSolanaFailures: integerOption("--max-solana-failures", 0),
    maximumPendingJobs: integerOption("--max-pending-jobs", 0),
    maximumFailedJobs: integerOption("--max-failed-jobs", 0),
    minimumCoinbaseTrades: integerOption("--min-coinbase-trades", 1),
    maximumCoinbaseIncidents: integerOption("--max-coinbase-incidents", 0),
  };
  const metrics = {
    solanaCompletedBatches: number(capture.batches, "completed Solana batches"),
    solanaFailures: number(capture.failures, "Solana failures"),
    pendingJobs: number(queue.pending, "pending normalization jobs"),
    failedJobs: number(queue.failed, "failed normalization jobs"),
    coinbaseTrades: number(coinbaseResult.marketEventsInserted, "Coinbase trades"),
    coinbaseIncidents: number(
      coinbaseResult.marketDataIncidentsInserted,
      "Coinbase market-data incidents",
    ),
  };
  const failures = [];
  if (metrics.solanaCompletedBatches < thresholds.minimumCompletedBatches)
    failures.push("too few completed Solana batches");
  if (metrics.solanaFailures > thresholds.maximumSolanaFailures)
    failures.push("Solana failure threshold exceeded");
  if (metrics.pendingJobs > thresholds.maximumPendingJobs)
    failures.push("normalization queue did not drain");
  if (metrics.failedJobs > thresholds.maximumFailedJobs) failures.push("normalization jobs failed");
  if (metrics.coinbaseTrades < thresholds.minimumCoinbaseTrades)
    failures.push("too few Coinbase trades");
  if (metrics.coinbaseIncidents > thresholds.maximumCoinbaseIncidents)
    failures.push("Coinbase incident threshold exceeded");

  const result = {
    status: failures.length === 0 ? "PASS" : "FAIL",
    manifestPath,
    evaluatedAt: new Date().toISOString(),
    thresholds,
    metrics,
    failures,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
