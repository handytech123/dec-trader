import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  CapitalEvent,
  EnrichmentClaim,
  MarketEvent,
  Provenance,
} from "@autonomous-trading-lab/capital-flow";
import { buildEvidencePacket } from "@autonomous-trading-lab/evidence";
import { contentHash } from "@autonomous-trading-lab/domain";
import { finalizeResearchProtocol } from "@autonomous-trading-lab/market-research";
import type { RawBlock } from "@autonomous-trading-lab/provider-sdk";
import { normalizeSolanaTransfers } from "@autonomous-trading-lab/solana-normalization";
import { ResearchDatabase } from "../src/database.js";
import { deterministicDomainId } from "../src/ids.js";

const hash = `sha256:${"a".repeat(64)}` as const;

describe("CFIE durable repositories", () => {
  it("persists verified addresses and lossless filtered transactions", async () => {
    const database = new ResearchDatabase("memory://");
    try {
      await database.migrate(
        fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
      );
      const verified = {
        address: "11111111111111111111111111111111",
        entityType: "PROTOCOL" as const,
        label: "Solana System Program",
        source: "official-registry",
        sourceUrl: "https://github.com/solana-program/system",
        evidenceHash: hash,
        validFrom: "2020-03-16T00:00:00.000Z",
        retrievedAt: "2026-10-03T12:00:00.000Z",
        schemaVersion: "1" as const,
      };
      expect(await database.persistVerifiedEntityAddress(verified)).toBe(true);
      expect(await database.persistVerifiedEntityAddress(verified)).toBe(false);
      expect(
        await database.persistVerifiedEntityAddress({
          ...verified,
          validFrom: "2026-10-04T00:00:00.000Z",
          retrievedAt: "2026-10-04T00:00:00.000Z",
        }),
      ).toBe(false);
      expect(
        (await database.verifiedEntityAddressAt(verified.address, "2026-10-03T12:00:01.000Z"))
          ?.label,
      ).toBe(verified.label);
      expect(
        await database.verifiedEntityAddressAt(verified.address, "2019-01-01T00:00:00.000Z"),
      ).toBeUndefined();
      const secondAddress = "22222222222222222222222222222222";
      await expect(
        database.persistVerifiedEntityAddresses([
          { ...verified, address: secondAddress },
          { ...verified, label: "Conflicting identity" },
        ]),
      ).rejects.toThrow(/conflicting verified attribution overlap/);
      expect(
        await database.verifiedEntityAddressAt(secondAddress, "2026-10-03T12:00:01.000Z"),
      ).toBeUndefined();

      const payload = {
        jsonrpc: "2.0",
        method: "transactionNotification",
        params: {
          subscription: 1,
          result: {
            context: { slot: 42 },
            value: {
              signature: "5".repeat(64),
              transaction: {},
              meta: null,
            },
          },
        },
      };
      const transaction = {
        providerId: "helius",
        filterId: "core-v1",
        subscriptionId: 1,
        slot: "42",
        signature: "5".repeat(64),
        receivedAt: "2026-10-03T12:00:00.000Z",
        commitment: "confirmed" as const,
        parserVersion: 1,
        payload,
      };
      expect(await database.persistFilteredTransaction(transaction)).toBe(true);
      expect(await database.persistFilteredTransaction(transaction)).toBe(false);
      expect(
        (await database.pendingFilteredTransactions(10)).map((item) => item.signature),
      ).toEqual([transaction.signature]);
      expect(
        await database.persistFilteredTransactionReconciliation({
          providerId: "helius",
          filterId: "core-v1",
          signature: transaction.signature,
          status: "FINALIZED",
          reconciledAt: "2026-10-03T12:01:00.000Z",
          finalizedBlockHash: "block-42",
        }),
      ).toBe(true);
      expect(await database.pendingFilteredTransactions(10)).toEqual([]);
      await database.upsertFilteredStreamCheckpoint({
        providerId: "helius",
        filterId: "core-v1",
        highestReceivedSlot: "42",
        highestReconciledSlot: "42",
        reconnectCount: 0,
        updatedAt: "2026-10-03T12:01:00.000Z",
      });
      const sourceBody = `Official address: ${verified.address}`;
      const snapshot = {
        sourceId: "official-registry",
        sourceUrl: verified.sourceUrl,
        retrievedAt: verified.retrievedAt,
        evidenceHash: contentHash(sourceBody),
        byteCount: Buffer.byteLength(sourceBody, "utf8"),
        body: sourceBody,
      };
      expect(await database.persistEntitySourceSnapshot(snapshot)).toBe(true);
      expect(await database.persistEntitySourceSnapshot(snapshot)).toBe(false);
    } finally {
      await database.close();
    }
  });

  it("links a finalized filtered transaction to canonical capital events without duplicating them", async () => {
    const database = new ResearchDatabase("memory://");
    try {
      await database.migrate(
        fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
      );
      const fixturePath = new URL(
        "../../../packages/solana-normalization/fixtures/parsed-transfer-block.json",
        import.meta.url,
      );
      // Repository-owned fixture path is constant and never accepts user input.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const block = JSON.parse(await readFile(fixturePath, "utf8")) as RawBlock;
      const signature = "signature-sol";
      await database.persistFilteredTransaction({
        providerId: "helius",
        filterId: "verified-entities-v1",
        subscriptionId: 1,
        slot: block.sequence,
        signature,
        receivedAt: "2026-01-01T00:00:00.500Z",
        commitment: "confirmed",
        parserVersion: 1,
        payload: { signature, slot: block.sequence },
      });
      await database.persistFilteredTransactionReconciliation({
        providerId: "helius",
        filterId: "verified-entities-v1",
        signature,
        status: "FINALIZED",
        reconciledAt: "2026-01-01T00:00:01.000Z",
        finalizedBlockHash: block.providerRef,
      });
      const batch = normalizeSolanaTransfers(block, "2026-01-01T00:00:02.000Z");
      const first = await database.persistCapitalBatch(block, batch);
      const second = await database.persistCapitalBatch(block, batch);
      expect(first.eventsInserted).toBeGreaterThan(0);
      expect(second.eventsInserted).toBe(0);
      const linked = await database.filteredTransactionNormalization(
        "helius",
        "verified-entities-v1",
        signature,
        3,
      );
      expect(linked).toMatchObject({
        signature,
        eventCount: 1,
        normalizedAt: "2026-01-01T00:00:02.000Z",
      });
      expect(linked?.eventIds).toEqual(
        batch.events
          .filter((event) => event.transactionHash === signature)
          .map((event) => event.eventId),
      );
      await expect(database.recentFilteredCapitalAlerts(10)).resolves.toMatchObject([
        {
          signature,
          reconciliationStatus: "FINALIZED",
          capitalEvents: [
            {
              eventId: linked?.eventIds[0],
              quantity: "1.25",
              outcomes: [],
            },
          ],
        },
      ]);
      expect(await database.linkExistingFinalizedFilteredTransactions(10)).toBe(0);
    } finally {
      await database.close();
    }
  });

  it("back-links a filtered alert when its canonical block was normalized first", async () => {
    const database = new ResearchDatabase("memory://");
    try {
      await database.migrate(
        fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
      );
      const fixturePath = new URL(
        "../../../packages/solana-normalization/fixtures/parsed-transfer-block.json",
        import.meta.url,
      );
      // Repository-owned fixture path is constant and never accepts user input.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const block = JSON.parse(await readFile(fixturePath, "utf8")) as RawBlock;
      const storage = database.chainCollectionStorage(() => "2026-01-01T00:00:01.000Z");
      await storage.append(block);
      const jobs = await database.claimChainNormalizationJobs("2026-01-01T00:00:02.000Z", 1000, 1);
      const job = jobs[0];
      if (!job) throw new Error("expected a normalization job");
      await database.persistCapitalBatch(
        block,
        normalizeSolanaTransfers(block, job.createdAt, String(job.parserVersion)),
      );
      await database.completeChainNormalizationJob(
        job.rawObjectHash,
        job.parserVersion,
        "2026-01-01T00:00:03.000Z",
      );
      await database.persistFilteredTransaction({
        providerId: "helius",
        filterId: "verified-entities-v1",
        subscriptionId: 1,
        slot: block.sequence,
        signature: "signature-sol",
        receivedAt: "2026-01-01T00:00:04.000Z",
        commitment: "confirmed",
        parserVersion: 1,
        payload: { signature: "signature-sol", slot: block.sequence },
      });
      await database.persistFilteredTransactionReconciliation({
        providerId: "helius",
        filterId: "verified-entities-v1",
        signature: "signature-sol",
        status: "FINALIZED",
        reconciledAt: "2026-01-01T00:00:05.000Z",
        finalizedBlockHash: block.providerRef,
      });
      await expect(
        database.linkExistingFinalizedFilteredTransactions(10, 3, "2026-01-01T00:00:06.000Z"),
      ).resolves.toBe(1);
      await expect(
        database.linkExistingFinalizedFilteredTransactions(10, 3, "2026-01-01T00:00:07.000Z"),
      ).resolves.toBe(0);
      const linked = await database.filteredTransactionNormalization(
        "helius",
        "verified-entities-v1",
        "signature-sol",
        3,
      );
      expect(linked?.eventCount).toBe(1);
    } finally {
      await database.close();
    }
  });
  it("freezes protocols and returns only point-in-time entity claims", async () => {
    const database = new ResearchDatabase("memory://");
    try {
      await database.migrate(
        fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
      );
      const subjectId = deterministicDomainId("entity", "fixture-wallet");
      const claim = {
        claimId: deterministicDomainId("claim", "fixture-wallet:exchange"),
        subjectId,
        claimType: "ENTITY_TYPE",
        value: "EXCHANGE",
        provider: "fixture",
        confidence: 0.9,
        evidenceRefs: [hash],
        validFrom: "2026-01-01T00:00:00.000Z",
        retrievedAt: "2026-01-02T00:00:00.000Z",
        schemaVersion: "1",
      } satisfies EnrichmentClaim;
      await expect(database.persistEnrichmentClaim(claim)).resolves.toBe(true);
      await expect(database.persistEnrichmentClaim(claim)).resolves.toBe(false);
      await expect(
        database.pointInTimeEnrichmentClaims(subjectId, "ENTITY_TYPE", "2026-01-01T12:00:00.000Z"),
      ).resolves.toEqual([]);
      await expect(
        database.pointInTimeEnrichmentClaims(subjectId, "ENTITY_TYPE", "2026-01-02T00:00:00.000Z"),
      ).resolves.toEqual([claim]);
      await expect(database.persistEnrichmentClaim({ ...claim, confidence: 0.8 })).rejects.toThrow(
        /identity collision/,
      );

      const protocol = finalizeResearchProtocol({
        protocolId: deterministicDomainId("protocol", "cfie-phase-1-fixture"),
        name: "CFIE Research Phase 1 fixture",
        version: "1",
        objective: "Test whether point-in-time capital flows contain forward information.",
        families: [
          {
            family: "TRANSFER_MAGNITUDE",
            hypothesis: "Magnitude matters.",
            features: ["transfer_z_score"],
            thresholds: ["1", "2", "3", "4"],
          },
          {
            family: "DIRECTION",
            hypothesis: "Direction matters.",
            features: ["entity_direction"],
            thresholds: [],
          },
          {
            family: "WALLET_BEHAVIOR",
            hypothesis: "Behavior matters.",
            features: ["wallet_anomaly"],
            thresholds: [],
          },
          {
            family: "MARKET_REACTION",
            hypothesis: "Reaction matters.",
            features: ["market_reaction"],
            thresholds: [],
          },
          {
            family: "CONDITIONAL_COMBINATION",
            hypothesis: "Locked combinations matter.",
            features: ["locked_combination"],
            thresholds: [],
          },
          {
            family: "FALSIFICATION",
            hypothesis: "Effects must survive controls.",
            features: ["control_comparison"],
            thresholds: [],
          },
        ],
        horizons: ["1m", "5m", "15m", "1h", "6h", "24h"],
        requiredControls: [
          "RANDOMIZED_TIMESTAMPS",
          "UNCONDITIONAL_SOL",
          "BTC_MARKET",
          "REGIME_STRATIFICATION",
          "REMOVE_LARGEST_FIVE",
          "WALK_FORWARD_HOLDOUT",
          "TRADING_COSTS",
        ],
        multipleTestingMethod: "BENJAMINI_HOCHBERG",
        falseDiscoveryRate: 0.05,
        minimumSampleSize: 100,
        holdoutFraction: 0.2,
        seed: "20261003",
        datasetCutoff: "2026-10-03T00:00:00.000Z",
        frozenAt: "2026-10-03T00:00:00.000Z",
        codeHash: hash,
      });
      await expect(database.persistResearchProtocol(protocol)).resolves.toBe(true);
      await expect(database.persistResearchProtocol(protocol)).resolves.toBe(false);
      await expect(database.researchProtocol(protocol.protocolId)).resolves.toEqual(protocol);
      await expect(
        database.persistResearchProtocol({
          ...protocol,
          contentHash: hash,
        }),
      ).rejects.toThrow(/content hash mismatch/);
    } finally {
      await database.close();
    }
  });

  it("computes and durably stores an evidence-backed reference price", async () => {
    const database = new ResearchDatabase("memory://");
    try {
      await database.migrate(
        fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
      );
      const coinbaseInstrument = deterministicDomainId("instrument", "coinbase:SOL-USD");
      const basisInstrument = deterministicDomainId("instrument", "coinbase:USDT-USD");
      const binanceInstrument = deterministicDomainId("instrument", "binance-us-spot:SOLUSDT");
      const persistTrade = async (
        identity: string,
        venue: string,
        instrumentId: string,
        price: string,
      ): Promise<void> => {
        const raw = await database.persistRawMarketMessage({
          source: "fixture",
          venue,
          messageType: "trade",
          ingestedAt: "2026-10-03T00:00:09.000Z",
          payload: { identity, price },
        });
        await database.persistMarketEvent({
          eventId: deterministicDomainId("event", identity),
          eventTime: "2026-10-03T00:00:09.000Z",
          ingestTime: "2026-10-03T00:00:09.000Z",
          source: "fixture",
          venue,
          instrumentId,
          eventType: "TRADE",
          price,
          quantity: "1",
          rawRef: raw.rawRef,
          schemaVersion: "1",
        });
      };
      await persistTrade("coinbase-sol", "coinbase-exchange", coinbaseInstrument, "150");
      await persistTrade("coinbase-basis", "coinbase-exchange", basisInstrument, "0.999");
      await persistTrade("binance-sol", "binance-us-spot", binanceInstrument, "150.15");
      await database.persistOrderBookSnapshot({
        venue: "binance-us-spot",
        instrumentId: binanceInstrument,
        sequence: "1",
        observedAt: "2026-10-03T00:00:09.500Z",
        bids: [{ price: "150.10", size: "10" }],
        asks: [{ price: "150.20", size: "10" }],
        inputRefs: [hash],
      });
      const estimate = await database.computeAndPersistReferencePrice(
        [
          {
            venue: "coinbase-exchange",
            instrumentId: coinbaseInstrument,
            baseAsset: "SOL",
            quoteAsset: "USD",
          },
          {
            venue: "binance-us-spot",
            instrumentId: binanceInstrument,
            baseAsset: "SOL",
            quoteAsset: "USDT",
          },
        ],
        {
          venue: "coinbase-exchange",
          instrumentId: basisInstrument,
          baseAsset: "USDT",
          quoteAsset: "USD",
        },
        {
          baseAsset: "SOL",
          asOf: "2026-10-03T00:00:10.000Z",
          minimumVenues: 2,
          maximumAgeMs: 10_000,
          maximumBasisAgeMs: 60_000,
          maximumDeviationBps: 100,
          maximumSpreadBps: 100,
        },
      );
      expect(estimate).toMatchObject({ status: "PUBLISHED", price: "149.999925" });
      await expect(
        database.computeAndPersistReferencePrice(
          [
            {
              venue: "coinbase-exchange",
              instrumentId: coinbaseInstrument,
              baseAsset: "SOL",
              quoteAsset: "USD",
            },
            {
              venue: "binance-us-spot",
              instrumentId: binanceInstrument,
              baseAsset: "SOL",
              quoteAsset: "USDT",
            },
          ],
          {
            venue: "coinbase-exchange",
            instrumentId: basisInstrument,
            baseAsset: "USDT",
            quoteAsset: "USD",
          },
          {
            baseAsset: "SOL",
            asOf: "2026-10-03T00:00:10.000Z",
            minimumVenues: 2,
            maximumAgeMs: 10_000,
            maximumBasisAgeMs: 60_000,
            maximumDeviationBps: 100,
            maximumSpreadBps: 100,
          },
        ),
      ).resolves.toEqual(estimate);
    } finally {
      await database.close();
    }
  });

  it("labels native SOL capital events only from point-in-time reference prices", async () => {
    const database = new ResearchDatabase("memory://");
    try {
      await database.migrate(
        fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
      );
      const fixturePath = new URL(
        "../../../packages/solana-normalization/fixtures/parsed-transfer-block.json",
        import.meta.url,
      );
      // Repository-owned fixture path is constant and never accepts user input.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as RawBlock;
      const block: RawBlock = {
        ...fixture,
        providerRef: "solana:slot:900:forward-outcome",
        sequence: "900",
        sourceTimestamp: "2026-01-01T00:00:20.000Z",
      };
      await database.persistCapitalBatch(
        block,
        normalizeSolanaTransfers(block, "2026-01-01T00:00:21.000Z"),
      );
      const coinbaseInstrument = deterministicDomainId("instrument", "coinbase:SOL-USD");
      const basisInstrument = deterministicDomainId("instrument", "coinbase:USDT-USD");
      const binanceInstrument = deterministicDomainId("instrument", "binance-us-spot:SOLUSDT");
      const persistPoint = async (suffix: string, at: string, price: string): Promise<void> => {
        for (const [venue, instrumentId, value] of [
          ["coinbase-exchange", coinbaseInstrument, price],
          ["coinbase-exchange", basisInstrument, "1"],
          ["binance-us-spot", binanceInstrument, price],
        ] as const) {
          const raw = await database.persistRawMarketMessage({
            source: "fixture",
            venue,
            messageType: "trade",
            ingestedAt: at,
            payload: { suffix, venue, instrumentId, value },
          });
          await database.persistMarketEvent({
            eventId: deterministicDomainId("event", `${suffix}:${venue}:${instrumentId}`),
            eventTime: at,
            ingestTime: at,
            source: "fixture",
            venue,
            instrumentId,
            eventType: "TRADE",
            price: value,
            quantity: "1",
            rawRef: raw.rawRef,
            schemaVersion: "1",
          });
        }
        await database.computeAndPersistReferencePrice(
          [
            {
              venue: "coinbase-exchange",
              instrumentId: coinbaseInstrument,
              baseAsset: "SOL",
              quoteAsset: "USD",
            },
            {
              venue: "binance-us-spot",
              instrumentId: binanceInstrument,
              baseAsset: "SOL",
              quoteAsset: "USDT",
            },
          ],
          {
            venue: "coinbase-exchange",
            instrumentId: basisInstrument,
            baseAsset: "USDT",
            quoteAsset: "USD",
          },
          {
            baseAsset: "SOL",
            asOf: at,
            minimumVenues: 2,
            maximumAgeMs: 30_000,
            maximumBasisAgeMs: 60_000,
            maximumDeviationBps: 100,
            maximumSpreadBps: 100,
          },
        );
      };
      await persistPoint("entry", "2026-01-01T00:00:10.000Z", "100");
      await persistPoint("exit", "2026-01-01T00:01:20.000Z", "110");
      const labeled = await database.labelCapitalEventForwardOutcomes(
        "2026-01-01T00:01:21.000Z",
        30,
        60,
      );
      expect(labeled).toBeGreaterThan(0);
      await expect(
        database.labelCapitalEventForwardOutcomes("2026-01-01T00:01:21.000Z", 30, 60),
      ).resolves.toBe(0);
      const bitcoinInstrument = deterministicDomainId("instrument", "coinbase:BTC-USD");
      for (const [suffix, at, price] of [
        ["btc-entry", "2026-01-01T00:00:15.000Z", "50000"],
        ["btc-exit", "2026-01-01T00:01:20.000Z", "50500"],
      ] as const) {
        const raw = await database.persistRawMarketMessage({
          source: "fixture",
          venue: "coinbase-exchange",
          productId: "BTC-USD",
          messageType: "trade",
          observedAt: at,
          ingestedAt: at,
          payload: { suffix, price },
        });
        await database.persistMarketEvent({
          eventId: deterministicDomainId("event", suffix),
          eventTime: at,
          ingestTime: at,
          source: "fixture",
          venue: "coinbase-exchange",
          instrumentId: bitcoinInstrument,
          eventType: "TRADE",
          price,
          quantity: "1",
          rawRef: raw.rawRef,
          schemaVersion: "1",
        });
      }
      const benchmarkInput = {
        venue: "coinbase-exchange",
        instrumentId: bitcoinInstrument,
        asOf: "2026-01-01T00:01:21.000Z",
      } as const;
      await expect(
        database.labelCapitalEventBenchmarkOutcomes(benchmarkInput),
      ).resolves.toBeGreaterThan(0);
      await expect(database.labelCapitalEventBenchmarkOutcomes(benchmarkInput)).resolves.toBe(0);
      const adjusted = await database.benchmarkAdjustedTransferMagnitudeObservations(
        "2026-01-01T00:01:21.000Z",
        bitcoinInstrument,
      );
      expect(adjusted).toEqual(
        expect.arrayContaining([expect.objectContaining({ horizon: "1m", returnPct: 9 })]),
      );
      const episodeMaterialization = await database.materializeCapitalFlowEpisodes({
        asOf: "2026-01-01T00:03:00.000Z",
        windowSeconds: 60,
        finalizationGraceSeconds: 60,
      });
      expect(episodeMaterialization.episodesInserted).toBe(1);
      expect(episodeMaterialization.eventsGrouped).toBeGreaterThan(0);
      await expect(
        database.materializeEpisodeProtocolContexts({
          asOf: "2026-01-01T00:03:00.000Z",
        }),
      ).resolves.toEqual({ contextsInserted: 1, verifiedEvents: 0 });
      await expect(
        database.materializeEpisodeProtocolContexts({
          asOf: "2026-01-01T00:03:00.000Z",
        }),
      ).resolves.toEqual({ contextsInserted: 0, verifiedEvents: 0 });
      await expect(
        database.materializeCapitalFlowEpisodes({
          asOf: "2026-01-01T00:03:00.000Z",
          windowSeconds: 60,
          finalizationGraceSeconds: 60,
        }),
      ).resolves.toEqual({ episodesInserted: 0, eventsGrouped: 0 });
      await expect(database.cfieDemoReport()).resolves.toMatchObject({
        counts: { capitalFlowEpisodes: 1 },
        episodeReadiness: { episodeCount: 1 },
      });
      await expect(
        database.episodeBenchmarkAdjustedTransferMagnitudeObservations(
          "2026-01-01T00:03:00.000Z",
          bitcoinInstrument,
        ),
      ).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ horizon: "1m", returnPct: 9 })]),
      );
    } finally {
      await database.close();
    }
  });
  it("reports explicit degraded and healthy operational states", async () => {
    const database = new ResearchDatabase("memory://");
    try {
      const migrations = fileURLToPath(
        new URL("../../../infra/postgres/migrations/", import.meta.url),
      );
      await database.migrate(migrations);
      await expect(database.operationalHealth("2026-01-01T00:00:00.000Z")).resolves.toMatchObject({
        status: "DEGRADED",
        reasons: ["no chain block recorded", "no market message recorded"],
      });
      const storage = database.chainCollectionStorage(() => "2026-01-01T00:00:00.000Z");
      expect(typeof storage.appendMany).toBe("function");
      await storage.append({
        providerRef: "solana:slot:1:block",
        chain: "solana",
        sequence: "1",
        sourceTimestamp: "2026-01-01T00:00:00.000Z",
        payload: { transactions: [] },
      });
      await database.persistRawMarketMessage({
        source: "fixture",
        venue: "coinbase",
        messageType: "ticker",
        ingestedAt: "2026-01-01T00:00:00.000Z",
        payload: { product_id: "SOL-USD" },
      });
      await expect(database.operationalHealth("2026-01-01T00:00:30.000Z")).resolves.toMatchObject({
        status: "HEALTHY",
        chainAgeSeconds: 30,
        marketAgeSeconds: 30,
        activeMarketIncidents: 0,
        reasons: [],
      });
    } finally {
      await database.close();
    }
  });

  it("atomically and idempotently persists a normalized capital batch", async () => {
    const database = new ResearchDatabase("memory://");
    try {
      const migrations = fileURLToPath(
        new URL("../../../infra/postgres/migrations/", import.meta.url),
      );
      await database.migrate(migrations);
      const fixturePath = new URL(
        "../../../packages/solana-normalization/fixtures/parsed-transfer-block.json",
        import.meta.url,
      );
      // Repository-owned fixture path is constant and never accepts user input.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const block = JSON.parse(await readFile(fixturePath, "utf8")) as RawBlock;
      const batch = normalizeSolanaTransfers(block, "2026-01-01T00:00:01.000Z");
      const firstAsset = batch.assets[0];
      if (!firstAsset) throw new Error("fixture unexpectedly produced no assets");

      await expect(
        database.persistCapitalBatch(block, {
          ...batch,
          assets: [...batch.assets, { ...firstAsset, assetId: "asset_01ARZ3NDEKTSV4RRFFQ69G5FAT" }],
        }),
      ).rejects.toThrow();

      const inserted = await database.persistCapitalBatch(block, batch);
      expect(inserted).toEqual({
        rawObservationsInserted: 1,
        rawBlocksInserted: 1,
        assetsInserted: batch.assets.length,
        entitiesInserted: batch.entities.length,
        eventsInserted: batch.events.length,
      });
      await expect(database.persistCapitalBatch(block, batch)).resolves.toEqual({
        rawObservationsInserted: 0,
        rawBlocksInserted: 0,
        assetsInserted: 0,
        entitiesInserted: 0,
        eventsInserted: 0,
      });
      const firstEvent = batch.events[0];
      if (!firstEvent) throw new Error("fixture unexpectedly produced no events");
      await expect(database.capitalEvent(firstEvent.eventId)).resolves.toEqual(firstEvent);
      await expect(database.capitalEvent("event_missing")).resolves.toBeUndefined();
    } finally {
      await database.close();
    }
  });

  it("persists checkpoints, raw blocks, market state, and retrievable evidence", async () => {
    const database = new ResearchDatabase("memory://");
    try {
      const migrations = fileURLToPath(
        new URL("../../../infra/postgres/migrations/", import.meta.url),
      );
      await database.migrate(migrations);
      const storage = database.chainCollectionStorage(() => "2026-01-01T00:00:01.000Z");
      const block: RawBlock = {
        providerRef: "solana:slot:1:block",
        chain: "solana",
        sequence: "1",
        sourceTimestamp: "2026-01-01T00:00:00.000Z",
        payload: { transactions: [] },
      };
      await storage.append(block);
      await storage.recordGap({
        providerId: "solana-rpc",
        chain: "solana",
        startSlot: 2,
        endSlot: 2,
        detectedAt: "2026-01-01T00:00:02.000Z",
        reason: "SKIPPED_OR_UNAVAILABLE",
      });
      await storage.save({
        providerId: "solana-rpc",
        chain: "solana",
        lastFinalizedSlot: 2,
        updatedAt: "2026-01-01T00:00:02.000Z",
      });
      await expect(storage.load("solana-rpc", "solana")).resolves.toEqual({
        providerId: "solana-rpc",
        chain: "solana",
        lastFinalizedSlot: 2,
        updatedAt: "2026-01-01T00:00:02.000Z",
      });

      const marketEvent: MarketEvent = {
        eventId: "event_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        eventTime: "2026-01-01T00:00:03.000Z",
        ingestTime: "2026-01-01T00:00:04.000Z",
        source: "fixture",
        venue: "coinbase",
        instrumentId: "instrument_01ARZ3NDEKTSV4RRFFQ69G5FAW",
        eventType: "TRADE",
        price: "100",
        quantity: "1",
        side: "BUY",
        bookSequence: "1",
        rawRef: hash,
        schemaVersion: "1",
      };
      await database.persistMarketEvent(marketEvent);
      await database.persistMarketEvent(marketEvent);
      const rawMarket = await database.persistRawMarketMessage({
        source: "fixture",
        venue: "coinbase",
        messageType: "fixture",
        ingestedAt: marketEvent.ingestTime,
        payload: { text: "preserve\u0000exactly" },
      });
      expect(rawMarket.inserted).toBe(true);
      expect(rawMarket.rawRef).toMatch(/^sha256:/);
      await expect(database.rawObject(rawMarket.rawRef)).resolves.toEqual({
        text: "preserve\u0000exactly",
      });
      await database.persistOrderBookSnapshot({
        venue: "coinbase",
        instrumentId: marketEvent.instrumentId,
        sequence: "1",
        observedAt: marketEvent.eventTime,
        bids: [{ price: "99", size: "1" }],
        asks: [{ price: "101", size: "1" }],
        inputRefs: [marketEvent.eventId],
      });

      const detectedEvent: CapitalEvent = {
        eventId: "event_01ARZ3NDEKTSV4RRFFQ69G5FAX",
        eventTime: "2026-01-01T00:00:00.000Z",
        ingestTime: "2026-01-01T00:00:01.000Z",
        source: "fixture",
        chain: "solana",
        eventType: "TRANSFER",
        assetId: "asset_01ARZ3NDEKTSV4RRFFQ69G5FAY",
        quantity: "1",
        usdValueAtEvent: null,
        fromEntityId: "entity_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        confidence: 1,
        rawRef: hash,
        schemaVersion: "1",
      };
      const provenance: Provenance = {
        sourceProvider: "fixture",
        sourceType: "FIXTURE",
        sourceId: "raw-1",
        observedAt: detectedEvent.eventTime,
        ingestedAt: detectedEvent.ingestTime,
        rawObjectRef: hash,
        schemaVersion: "1",
        parserVersion: "1",
      };
      const packet = buildEvidencePacket({
        generatedAt: "2026-01-01T00:01:00.000Z",
        detectedEvent,
        provenance,
        entities: [],
        features: [],
        historicalAnalogueCount: 0,
        forwardOutcomeSummary: {},
        contradictions: [],
        dataQuality: "PARTIAL",
        confidence: 0.5,
      });
      await database.persistEvidencePacket(packet);
      await expect(database.evidencePacket(packet.packetId)).resolves.toEqual(packet);
      await expect(database.evidencePacket("evidence_missing")).resolves.toBeUndefined();
    } finally {
      await database.close();
    }
  });

  it("prunes only terminal raw objects and preserves normalized research records", async () => {
    const database = new ResearchDatabase("memory://");
    try {
      await database.migrate(
        fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
      );
      const fixturePath = new URL(
        "../../../packages/solana-normalization/fixtures/parsed-transfer-block.json",
        import.meta.url,
      );
      // Repository-owned fixture path is constant and never accepts user input.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const block = JSON.parse(await readFile(fixturePath, "utf8")) as RawBlock;
      const rawRef = normalizeSolanaTransfers(block, "2026-01-01T00:00:01.000Z").provenance
        .rawObjectRef;
      const storage = database.chainCollectionStorage(() => "2026-01-01T00:00:01.000Z");
      await storage.append(block);
      await expect(
        database.enforceRawRetention("2026-01-02T00:00:00.000Z", 100, "2026-01-02T00:00:01.000Z"),
      ).resolves.toMatchObject({ objectsDeleted: 0 });
      const jobs = await database.claimChainNormalizationJobs("2026-01-02T00:00:02.000Z", 1000, 1);
      const job = jobs[0];
      if (!job) throw new Error("expected a normalization job");
      const batch = normalizeSolanaTransfers(block, job.createdAt, String(job.parserVersion));
      await database.persistCapitalBatch(block, batch);
      await database.completeChainNormalizationJob(
        job.rawObjectHash,
        job.parserVersion,
        "2026-01-02T00:00:03.000Z",
      );
      const firstEvent = batch.events[0];
      if (!firstEvent) throw new Error("fixture unexpectedly produced no events");
      const result = await database.enforceRawRetention(
        "2026-01-02T00:00:00.000Z",
        100,
        "2026-01-02T00:00:04.000Z",
      );
      expect(result).toMatchObject({
        objectsDeleted: 1,
        chainBlocksDeleted: 1,
        normalizationJobsDeleted: 1,
        rawObservationLinksCleared: 1,
      });
      expect(result.compressedBytesDeleted).toBeGreaterThan(0);
      await expect(database.recentRawRetentionRuns(1)).resolves.toEqual([result]);
      await expect(database.rawObject(rawRef)).resolves.toBeUndefined();
      await expect(database.capitalEvent(firstEvent.eventId)).resolves.toEqual(firstEvent);
    } finally {
      await database.close();
    }
  });

  it("computes and immutably persists a bounded market reaction window", async () => {
    const database = new ResearchDatabase("memory://");
    try {
      await database.migrate(
        fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
      );
      const fixturePath = new URL(
        "../../../packages/solana-normalization/fixtures/parsed-transfer-block.json",
        import.meta.url,
      );
      // Repository-owned fixture path is constant and never accepts user input.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const block = JSON.parse(await readFile(fixturePath, "utf8")) as RawBlock;
      const batch = normalizeSolanaTransfers(block, "2026-01-01T00:00:01.000Z");
      await database.persistCapitalBatch(block, batch);
      const event = batch.events.find((candidate) => candidate.quantity === "1.25");
      if (!event) throw new Error("native SOL fixture event unexpectedly missing");
      const instrumentId = deterministicDomainId("instrument", "coinbase:SOL-USD");
      await database.persistOrderBookSnapshot({
        venue: "coinbase-exchange",
        instrumentId,
        sequence: "1",
        observedAt: "2025-12-31T23:59:59.000Z",
        bids: [{ price: "99", size: "2" }],
        asks: [{ price: "101", size: "2" }],
        inputRefs: [hash],
      });
      await database.persistOrderBookSnapshot({
        venue: "coinbase-exchange",
        instrumentId,
        sequence: "2",
        observedAt: "2026-01-01T00:01:00.000Z",
        bids: [{ price: "100", size: "1" }],
        asks: [{ price: "102", size: "1" }],
        inputRefs: [hash],
      });
      await database.persistMarketEvent({
        eventId: deterministicDomainId("event", "reaction-trade"),
        eventTime: "2026-01-01T00:00:30.000Z",
        ingestTime: "2026-01-01T00:00:31.000Z",
        source: "fixture",
        venue: "coinbase-exchange",
        instrumentId,
        eventType: "TRADE",
        price: "101",
        quantity: "3",
        side: "BUY",
        rawRef: hash,
        schemaVersion: "1",
      });
      const input = {
        capitalEventId: event.eventId,
        venue: "coinbase-exchange",
        instrumentId,
        windowSeconds: 60,
      } as const;
      await expect(
        database.pendingMarketReactionEventIds({
          ...input,
          asOf: "2026-01-01T00:01:00.000Z",
          maximumEvents: 10,
        }),
        // Scheduling excludes reaction windows that cannot yet be paired with a forward outcome.
      ).resolves.toEqual([]);
      const first = await database.computeAndPersistMarketReaction(input);
      const replay = await database.computeAndPersistMarketReaction(input);
      expect(replay).toEqual(first);
      expect(first.features).toMatchObject({
        aggressiveBuyVolume: "3",
        aggressiveSellVolume: "0",
        midPriceReturnPct: "1",
        inputEventIds: [deterministicDomainId("event", "reaction-trade")],
      });
      await expect(database.capitalEventDetail(event.eventId)).resolves.toMatchObject({
        event: { eventId: event.eventId, quantity: "1.25" },
        outcomes: [],
        marketReactions: [
          {
            featureId: first.featureId,
            windowSeconds: 60,
            features: { aggressiveBuyVolume: "3" },
          },
        ],
      });
      await expect(
        database.capitalEventDetail("event_00000000000000000000000000"),
      ).resolves.toBeUndefined();
      await expect(
        database.pendingMarketReactionEventIds({
          ...input,
          asOf: "2026-01-01T00:01:00.000Z",
          maximumEvents: 10,
        }),
      ).resolves.not.toContain(event.eventId);
      await expect(
        database.computeAndPersistMarketReaction({ ...input, windowSeconds: 42 }),
      ).rejects.toThrow(/registered research horizon/);
      const report = await database.cfieDemoReport();
      expect(report.collectionService.status).toBe("NOT_CONFIGURED");
      expect(report.counts.marketReactionFeatures).toBe(1);
      expect(report.horizonMaturation.find((item) => item.horizon === "1m")).toMatchObject({
        windowSeconds: 60,
        reactionCount: 1,
        uniqueReactionTimestampCount: 1,
      });
      await database.persistMarketDataIncident({
        incidentType: "RECONNECT",
        source: "fixture",
        venue: "coinbase-exchange",
        productId: "SOL-USD",
        detectedAt: "2026-01-01T00:00:40.000Z",
        details: { reason: "test discontinuity" },
      });
      await expect(database.computeAndPersistMarketReaction(input)).rejects.toThrow(
        /overlaps a market-data incident/,
      );
    } finally {
      await database.close();
    }
  });

  it("prunes expired raw market frames in a bounded audited batch", async () => {
    const database = new ResearchDatabase("memory://");
    try {
      await database.migrate(
        fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
      );
      const raw = await database.persistRawMarketMessage({
        source: "fixture",
        venue: "coinbase",
        productId: "SOL-USD",
        messageType: "match",
        ingestedAt: "2026-01-01T00:00:00.000Z",
        payload: { type: "match", price: "100" },
      });
      const result = await database.enforceRawRetention(
        "2026-01-02T00:00:00.000Z",
        1,
        "2026-01-02T00:00:01.000Z",
      );
      expect(result).toMatchObject({ objectsDeleted: 1, marketMessagesDeleted: 1 });
      await expect(database.rawObject(raw.rawRef)).resolves.toBeUndefined();
    } finally {
      await database.close();
    }
  });

  it("preserves expired raw objects referenced by filtered provenance", async () => {
    const database = new ResearchDatabase("memory://");
    try {
      await database.migrate(
        fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
      );
      const payload = { signature: "protected-filtered-signature", slot: 1 };
      const rawRef = contentHash(payload);
      await database.persistFilteredTransaction({
        providerId: "fixture",
        filterId: "retention-protection",
        subscriptionId: 1,
        signature: payload.signature,
        slot: String(payload.slot),
        receivedAt: "2026-01-01T00:00:00.000Z",
        commitment: "confirmed",
        parserVersion: 1,
        payload,
      });
      const result = await database.enforceRawRetention(
        "2026-01-02T00:00:00.000Z",
        100,
        "2026-01-02T00:00:01.000Z",
      );
      expect(result.objectsDeleted).toBe(0);
      await expect(database.rawObject(rawRef)).resolves.toBeDefined();
    } finally {
      await database.close();
    }
  });
});
