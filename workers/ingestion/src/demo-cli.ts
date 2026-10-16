import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  PublicMarketConnection,
  PublicMarketConnectionFactory,
} from "@autonomous-trading-lab/coinbase-market-provider";
import type { RawBlock } from "@autonomous-trading-lab/provider-sdk";
import { buildEvidencePacket } from "@autonomous-trading-lab/evidence";
import { contentHash } from "@autonomous-trading-lab/domain";
import { normalizeSolanaTransfers } from "@autonomous-trading-lab/solana-normalization";
import { ResearchDatabase } from "./database.js";
import { drainSolanaNormalizationQueue, runBoundedCoinbaseObservation } from "./observation.js";

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

async function main(): Promise<void> {
  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  const databasePath = resolve(
    invocationDirectory,
    option("--database-path") ?? ".atl-data/cfie-demo",
  );
  const database = new ResearchDatabase(databasePath);
  try {
    await database.migrate(resolve(invocationDirectory, "infra/postgres/migrations"));
    const fixturePath = resolve(
      invocationDirectory,
      "packages/solana-normalization/fixtures/parsed-transfer-block.json",
    );
    // Repository-owned fixture path is fixed relative to the invocation directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const block = JSON.parse(await readFile(fixturePath, "utf8")) as RawBlock;
    await database.chainCollectionStorage(() => "2026-01-01T00:00:01.000Z").append(block);
    const normalization = await drainSolanaNormalizationQueue(
      database,
      {
        maximumJobs: 10,
        claimBatchSize: 2,
        leaseMs: 60_000,
        maximumAttempts: 3,
        retryBackoffMs: 0,
      },
      new AbortController().signal,
    );
    const capitalBatch = normalizeSolanaTransfers(block, "2026-01-01T00:00:01.000Z");
    const registryRetrievedAt = "2025-12-31T00:00:00.000Z";
    for (const record of [
      {
        address: "Sender11111111111111111111111111111111111111",
        entityType: "PROTOCOL" as const,
        label: "Demo treasury",
      },
      {
        address: "Receiver1111111111111111111111111111111111",
        entityType: "EXCHANGE" as const,
        label: "Demo exchange",
      },
    ]) {
      await database.persistVerifiedEntityAddress({
        ...record,
        source: "cfie-offline-fixture",
        sourceUrl: "https://example.invalid/cfie-offline-fixture",
        evidenceHash: contentHash({ fixture: "parsed-transfer-block", address: record.address }),
        validFrom: "2025-01-01T00:00:00.000Z",
        retrievedAt: registryRetrievedAt,
        schemaVersion: "1",
      });
    }
    const detectedEvent = capitalBatch.events[0];
    if (!detectedEvent) throw new Error("demo block produced no capital event");
    await database.persistEvidencePacket(
      buildEvidencePacket({
        generatedAt: "2026-01-01T00:00:05.000Z",
        detectedEvent,
        provenance: capitalBatch.provenance,
        entities: capitalBatch.entities.filter(
          (entity) =>
            entity.entityId === detectedEvent.fromEntityId ||
            entity.entityId === detectedEvent.toEntityId,
        ),
        features: [
          {
            name: "observed_transfer_quantity",
            algorithmVersion: "1",
            inputEventIds: [detectedEvent.eventId],
            value: detectedEvent.quantity,
          },
        ],
        historicalAnalogueCount: 0,
        forwardOutcomeSummary: {},
        contradictions: ["No economic usefulness has been established"],
        dataQuality: "PARTIAL",
        confidence: 0.5,
      }),
    );
    const messages = [
      { trade_id: 7001, sequence: 9001, price: "147.25", size: "12.5", side: "buy" },
      { trade_id: 7002, sequence: 9002, price: "147.40", size: "8.2", side: "sell" },
      { trade_id: 7003, sequence: 9003, price: "147.55", size: "15.1", side: "buy" },
    ].map((message, index) => ({
      type: "match",
      time: `2026-01-01T00:00:0${String(index + 2)}.000Z`,
      product_id: "SOL-USD",
      ...message,
    }));
    const connection: PublicMarketConnection = {
      async *messages(): AsyncIterable<unknown> {
        for (const message of messages) yield await Promise.resolve(message);
      },
      close: () => Promise.resolve(),
    };
    const factory: PublicMarketConnectionFactory = {
      connect: () => Promise.resolve(connection),
    };
    const coinbase = await runBoundedCoinbaseObservation(
      factory,
      database,
      {
        maximumMessages: messages.length,
        maximumDurationMs: 5000,
        reconnect: { maximumAttempts: 0, baseDelayMs: 100, maximumDelayMs: 100 },
      },
      new AbortController().signal,
    );
    const filteredPayload = {
      jsonrpc: "2.0",
      method: "transactionNotification",
      params: {
        subscription: 1,
        result: {
          context: { slot: 200 },
          value: { signature: "signature-sol-demo-filtered-111111", transaction: {}, meta: null },
        },
      },
    };
    await database.persistFilteredTransaction({
      providerId: "fixture-filtered-stream",
      filterId: "demo-core-programs-v1",
      subscriptionId: 1,
      slot: "200",
      signature: "signature-sol-demo-filtered-111111",
      receivedAt: "2026-01-01T00:00:01.000Z",
      commitment: "confirmed",
      parserVersion: 1,
      payload: filteredPayload,
    });
    await database.persistFilteredTransactionReconciliation({
      providerId: "fixture-filtered-stream",
      filterId: "demo-core-programs-v1",
      signature: "signature-sol-demo-filtered-111111",
      status: "FINALIZED",
      reconciledAt: "2026-01-01T00:00:02.000Z",
      finalizedBlockHash: block.providerRef,
    });
    const report = await database.cfieDemoReport();
    process.stdout.write(
      `${JSON.stringify({ mode: "DETERMINISTIC_OFFLINE_DEMO", databasePath, normalization, coinbase, report })}\n`,
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
