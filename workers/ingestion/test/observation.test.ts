import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  PublicMarketConnection,
  PublicMarketConnectionFactory,
} from "@autonomous-trading-lab/coinbase-market-provider";
import type { RawBlock } from "@autonomous-trading-lab/provider-sdk";
import type { FinalizedBlockSource } from "@autonomous-trading-lab/solana-chain-provider";
import { ResearchDatabase } from "../src/database.js";
import {
  drainSolanaNormalizationQueue,
  runBoundedCoinbaseObservation,
  runBoundedSolanaCapture,
  runBoundedSolanaNormalizationWorker,
  runBoundedSolanaObservation,
} from "../src/observation.js";

describe("bounded read-only observation", () => {
  it("records a finite public Coinbase dataset and stops at the message budget", async () => {
    const messages = [
      {
        type: "snapshot",
        product_id: "BTC-USD",
        bids: [["99", "1"]],
        asks: [["101", "1"]],
      },
      {
        type: "match",
        trade_id: 1,
        sequence: 10,
        time: "2026-01-01T00:00:00.000Z",
        product_id: "BTC-USD",
        size: "0.1",
        price: "100",
        side: "sell",
      },
      { type: "heartbeat", sequence: 11, product_id: "BTC-USD" },
    ];
    const connection: PublicMarketConnection = {
      async *messages(): AsyncIterable<unknown> {
        for (const message of messages) yield await Promise.resolve(message);
      },
      close: () => Promise.resolve(),
    };
    const factory: PublicMarketConnectionFactory = {
      connect: () => Promise.resolve(connection),
    };
    const database = new ResearchDatabase("memory://");
    try {
      await database.migrate(
        fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
      );
      await expect(
        runBoundedCoinbaseObservation(
          factory,
          database,
          {
            maximumMessages: 3,
            maximumDurationMs: 1000,
            reconnect: { maximumAttempts: 0, baseDelayMs: 100, maximumDelayMs: 100 },
          },
          new AbortController().signal,
        ),
      ).resolves.toEqual({
        connections: 1,
        messages: 3,
        reconnects: 0,
        rawMessagesInserted: 3,
        marketEventsInserted: 1,
        bookSnapshotsInserted: 1,
        marketDataIncidentsInserted: 0,
        backfilledMarketEvents: 0,
        stoppedByLimit: true,
      });
    } finally {
      await database.close();
    }
  });

  it("durably records a Coinbase trade gap before failing closed", async () => {
    const messages = [1, 3].map((tradeId) => ({
      type: "match",
      trade_id: tradeId,
      sequence: tradeId,
      time: `2026-01-01T00:00:0${String(tradeId)}.000Z`,
      product_id: "SOL-USD",
      size: "1",
      price: "100",
      side: "sell",
    }));
    const database = new ResearchDatabase("memory://");
    try {
      await database.migrate(
        fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
      );
      await expect(
        runBoundedCoinbaseObservation(
          {
            connect: () =>
              Promise.resolve({
                async *messages(): AsyncIterable<unknown> {
                  for (const message of messages) yield await Promise.resolve(message);
                },
                close: () => Promise.resolve(),
              }),
          },
          database,
          {
            maximumMessages: 10,
            maximumDurationMs: 1000,
            reconnect: { maximumAttempts: 0, baseDelayMs: 100, maximumDelayMs: 100 },
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/gap/);
      const report = await database.cfieDemoReport();
      expect(report.counts).toMatchObject({ marketEvents: 1, marketDataIncidents: 1 });
    } finally {
      await database.close();
    }
  });

  it("repairs a bounded Coinbase gap before accepting the current trade", async () => {
    const trade = (tradeId: number) => ({
      type: "match",
      trade_id: tradeId,
      sequence: tradeId,
      time: `2026-01-01T00:00:0${String(tradeId)}.000Z`,
      product_id: "SOL-USD",
      size: "1",
      price: String(100 + tradeId),
      side: "sell",
    });
    const database = new ResearchDatabase("memory://");
    try {
      await database.migrate(
        fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
      );
      const result = await runBoundedCoinbaseObservation(
        {
          connect: () =>
            Promise.resolve({
              async *messages(): AsyncIterable<unknown> {
                yield await Promise.resolve(trade(1));
                yield await Promise.resolve(trade(3));
              },
              close: () => Promise.resolve(),
            }),
        },
        database,
        {
          maximumMessages: 2,
          maximumDurationMs: 1000,
          reconnect: { maximumAttempts: 0, baseDelayMs: 100, maximumDelayMs: 100 },
          maximumBackfillTrades: 10,
        },
        new AbortController().signal,
        undefined,
        { fetchTrades: () => Promise.resolve([trade(2)]) },
      );
      expect(result).toMatchObject({
        messages: 2,
        rawMessagesInserted: 3,
        marketEventsInserted: 2,
        backfilledMarketEvents: 1,
        marketDataIncidentsInserted: 1,
      });
      const report = await database.cfieDemoReport();
      expect(report.counts).toMatchObject({ marketEvents: 3, marketDataIncidents: 1 });
    } finally {
      await database.close();
    }
  });

  it("records and re-anchors after a Coinbase gap larger than the bounded backfill policy", async () => {
    const trade = (tradeId: number) => ({
      type: "match",
      trade_id: tradeId,
      sequence: tradeId,
      time: "2026-01-01T00:00:01.000Z",
      product_id: "SOL-USD",
      size: "1",
      price: "100",
      side: "sell",
    });
    const database = new ResearchDatabase("memory://");
    try {
      await database.migrate(
        fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
      );
      const result = await runBoundedCoinbaseObservation(
        {
          connect: () =>
            Promise.resolve({
              async *messages(): AsyncIterable<unknown> {
                yield await Promise.resolve(trade(1));
                yield await Promise.resolve(trade(20));
              },
              close: () => Promise.resolve(),
            }),
        },
        database,
        {
          maximumMessages: 2,
          maximumDurationMs: 1000,
          reconnect: { maximumAttempts: 0, baseDelayMs: 100, maximumDelayMs: 100 },
          maximumBackfillTrades: 10,
        },
        new AbortController().signal,
        undefined,
        { fetchTrades: () => Promise.reject(new Error("oversized gaps must not be fetched")) },
        "SOL-USD",
      );
      expect(result).toMatchObject({
        messages: 2,
        marketEventsInserted: 2,
        backfilledMarketEvents: 0,
        marketDataIncidentsInserted: 1,
        reconnects: 0,
      });
      expect(
        await database.loadMarketTradeCheckpoint(
          "coinbase-exchange-matches",
          "coinbase-exchange",
          "SOL-USD",
        ),
      ).toBe(20);
    } finally {
      await database.close();
    }
  });

  it("continues Coinbase trade sequencing from a durable restart checkpoint", async () => {
    const trade = (tradeId: number) => ({
      type: "match",
      trade_id: tradeId,
      sequence: tradeId,
      time: `2026-01-01T00:00:0${String(tradeId)}.000Z`,
      product_id: "SOL-USD",
      size: "1",
      price: "100",
      side: "sell",
    });
    const factoryFor = (messages: readonly unknown[]): PublicMarketConnectionFactory => ({
      connect: () =>
        Promise.resolve({
          async *messages(): AsyncIterable<unknown> {
            for (const message of messages) yield await Promise.resolve(message);
          },
          close: () => Promise.resolve(),
        }),
    });
    const database = new ResearchDatabase("memory://");
    try {
      await database.migrate(
        fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
      );
      await runBoundedCoinbaseObservation(
        factoryFor([trade(1)]),
        database,
        {
          maximumMessages: 1,
          maximumDurationMs: 1000,
          reconnect: { maximumAttempts: 0, baseDelayMs: 100, maximumDelayMs: 100 },
        },
        new AbortController().signal,
        undefined,
        undefined,
        "SOL-USD",
      );
      expect(
        await database.loadMarketTradeCheckpoint(
          "coinbase-exchange-matches",
          "coinbase-exchange",
          "SOL-USD",
        ),
      ).toBe(1);
      const restarted = await runBoundedCoinbaseObservation(
        factoryFor([trade(3)]),
        database,
        {
          maximumMessages: 1,
          maximumDurationMs: 1000,
          reconnect: { maximumAttempts: 0, baseDelayMs: 100, maximumDelayMs: 100 },
          maximumBackfillTrades: 10,
        },
        new AbortController().signal,
        undefined,
        { fetchTrades: () => Promise.resolve([trade(2)]) },
        "SOL-USD",
      );
      expect(restarted).toMatchObject({
        marketEventsInserted: 1,
        backfilledMarketEvents: 1,
        marketDataIncidentsInserted: 1,
      });
      expect(
        await database.loadMarketTradeCheckpoint(
          "coinbase-exchange-matches",
          "coinbase-exchange",
          "SOL-USD",
        ),
      ).toBe(3);
    } finally {
      await database.close();
    }
  });

  it("records a finite finalized Solana dataset and stops at the poll budget", async () => {
    const fixturePath = new URL(
      "../../../packages/solana-normalization/fixtures/parsed-transfer-block.json",
      import.meta.url,
    );
    // Repository-owned fixture path is constant and never accepts user input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const block = JSON.parse(await readFile(fixturePath, "utf8")) as RawBlock;
    const provider: FinalizedBlockSource = {
      providerId: () => "solana-rpc",
      latestFinalizedSlot: () => Promise.resolve(200),
      confirmedBlockSlots: () => Promise.resolve([200]),
      getBlock: () => Promise.resolve(block),
    };
    const database = new ResearchDatabase("memory://");
    try {
      await database.migrate(
        fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
      );
      await expect(
        runBoundedSolanaObservation(
          provider,
          database,
          {
            initialSlot: 200,
            maximumBatchSlots: 10,
            maximumPolls: 2,
            pollIntervalMs: 250,
            maximumConsecutiveFailures: 0,
            failureBackoffMs: 250,
          },
          new AbortController().signal,
          () => Promise.resolve(),
        ),
      ).resolves.toEqual({
        polls: 2,
        batches: 1,
        blocks: 1,
        gaps: 0,
        capitalEvents: 2,
        failures: 0,
        backpressurePauses: 0,
        stoppedByAbort: false,
      });
    } finally {
      await database.close();
    }
  });

  it("captures raw Solana blocks before bounded asynchronous normalization", async () => {
    const fixturePath = new URL(
      "../../../packages/solana-normalization/fixtures/parsed-transfer-block.json",
      import.meta.url,
    );
    // Repository-owned fixture path is constant and never accepts user input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const block = JSON.parse(await readFile(fixturePath, "utf8")) as RawBlock;
    const provider: FinalizedBlockSource = {
      providerId: () => "solana-rpc",
      latestFinalizedSlot: () => Promise.resolve(200),
      confirmedBlockSlots: () => Promise.resolve([200]),
      getBlock: () => Promise.resolve(block),
    };
    const database = new ResearchDatabase("memory://");
    try {
      await database.migrate(
        fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
      );
      const capture = await runBoundedSolanaCapture(
        provider,
        database,
        {
          initialSlot: 200,
          maximumBatchSlots: 10,
          maximumPolls: 1,
          pollIntervalMs: 250,
          maximumConsecutiveFailures: 0,
          failureBackoffMs: 250,
        },
        new AbortController().signal,
      );
      expect(capture).toMatchObject({ blocks: 1, capitalEvents: 0 });
      let queriedWhileBackpressured = false;
      const paused = await runBoundedSolanaCapture(
        {
          providerId: () => "solana-rpc",
          latestFinalizedSlot: () => {
            queriedWhileBackpressured = true;
            return Promise.resolve(201);
          },
          confirmedBlockSlots: () => Promise.resolve([]),
          getBlock: () => Promise.reject(new Error("unexpected block fetch")),
        },
        database,
        {
          initialSlot: 201,
          maximumBatchSlots: 10,
          maximumPolls: 1,
          pollIntervalMs: 250,
          maximumConsecutiveFailures: 0,
          failureBackoffMs: 250,
          maximumPendingNormalizationJobs: 1,
        },
        new AbortController().signal,
      );
      expect(paused).toMatchObject({ blocks: 0, backpressurePauses: 1 });
      expect(queriedWhileBackpressured).toBe(false);
      await expect(
        runBoundedSolanaNormalizationWorker(
          database,
          {
            maximumJobs: 10,
            claimBatchSize: 2,
            leaseMs: 1000,
            maximumAttempts: 3,
            retryBackoffMs: 0,
          },
          1,
          100,
          new AbortController().signal,
        ),
      ).resolves.toEqual({
        cycles: 1,
        claimed: 1,
        completed: 1,
        retried: 0,
        failed: 0,
        capitalEvents: 2,
      });
      await expect(
        drainSolanaNormalizationQueue(
          database,
          {
            maximumJobs: 10,
            claimBatchSize: 2,
            leaseMs: 1000,
            maximumAttempts: 3,
            retryBackoffMs: 0,
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ claimed: 0, completed: 0, capitalEvents: 0 });
    } finally {
      await database.close();
    }
  });

  it("bounds poison-block normalization retries", async () => {
    const block: RawBlock = {
      providerRef: "bad-block",
      chain: "solana",
      sequence: "201",
      sourceTimestamp: "2026-01-01T00:00:00.000Z",
      payload: {},
    };
    const provider: FinalizedBlockSource = {
      providerId: () => "solana-rpc",
      latestFinalizedSlot: () => Promise.resolve(201),
      confirmedBlockSlots: () => Promise.resolve([201]),
      getBlock: () => Promise.resolve(block),
    };
    const database = new ResearchDatabase("memory://");
    try {
      await database.migrate(
        fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
      );
      await runBoundedSolanaCapture(
        provider,
        database,
        {
          initialSlot: 201,
          maximumBatchSlots: 1,
          maximumPolls: 1,
          pollIntervalMs: 250,
          maximumConsecutiveFailures: 0,
          failureBackoffMs: 250,
        },
        new AbortController().signal,
      );
      await expect(
        drainSolanaNormalizationQueue(
          database,
          {
            maximumJobs: 10,
            claimBatchSize: 1,
            leaseMs: 1000,
            maximumAttempts: 2,
            retryBackoffMs: 0,
          },
          new AbortController().signal,
        ),
      ).resolves.toEqual({
        claimed: 2,
        completed: 0,
        retried: 1,
        failed: 1,
        capitalEvents: 0,
      });
    } finally {
      await database.close();
    }
  });

  it("rejects an unbounded polling configuration", async () => {
    const provider = {} as FinalizedBlockSource;
    const database = {} as ResearchDatabase;
    await expect(
      runBoundedSolanaObservation(
        provider,
        database,
        {
          initialSlot: 0,
          maximumBatchSlots: 501,
          maximumPolls: 1,
          pollIntervalMs: 250,
          maximumConsecutiveFailures: 0,
          failureBackoffMs: 250,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/500/);
  });
});
