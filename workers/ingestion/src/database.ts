import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { Decimal } from "decimal.js";
import { z } from "zod";
import {
  CapitalEventSchema,
  constructCapitalFlowEpisodes,
  defaultEpisodeConstructionConfig,
  EnrichmentClaimSchema,
  EntitySchema,
  MarketEventSchema,
  VerifiedEntityAddressSchema,
  computeWalletBehaviorFeature,
  computeWalletBehaviorFeatureV2,
  type CapitalEvent,
  type EpisodeEntityClass,
  type EnrichmentClaim,
  type MarketEvent,
  type VerifiedEntityAddress,
  type WalletBehaviorFeature,
  type WalletBehaviorFeatureV2,
  type WalletBehaviorEvent,
} from "@autonomous-trading-lab/capital-flow";
import { contentHash } from "@autonomous-trading-lab/domain";
import {
  applyPaperFill,
  evaluatePaperRisk,
  simulatePaperFill,
  type PaperPortfolio,
} from "@autonomous-trading-lab/backtest";
import {
  referenceStyleLibrary,
  selectPaperStyle,
  trainReferenceStyle,
  validateReferenceStyleWalkForward,
  type MarketRegime,
  type StyleTrainingObservation,
} from "@autonomous-trading-lab/strategy-sdk";
import type { NansenChangeFeature, NansenMetricSnapshot } from "@autonomous-trading-lab/enrichment";
import { EvidencePacketSchema, type EvidencePacket } from "@autonomous-trading-lab/evidence";
import {
  computeMarketFeaturesV1,
  computeReferencePrice,
  classifyMarketRegime,
  summarizeResearchValidation,
  type CategoricalFlowAnalysis,
  type CategoricalFlowObservation,
  type TransferMagnitudeAnalysis,
  type TransferOutcomeObservation,
  type MarketPoint,
  type QuoteBasisObservation,
  type ReferencePriceConfig,
  type ReferencePriceEstimate,
  type ReferencePriceObservation,
  type MarketRegimeResult,
  ResearchProtocolSchema,
  type ResearchFindingPacket,
  type ResearchProtocol,
} from "@autonomous-trading-lab/market-research";
import type { RawBlock } from "@autonomous-trading-lab/provider-sdk";
import {
  computeMarketReactionFeatures,
  type MarketReactionFeatures,
  type OrderBookSnapshot,
  type TimedTrade,
} from "@autonomous-trading-lab/order-flow";
import type {
  ChainCheckpoint,
  ChainCheckpointStore,
  RawBlockSink,
  SlotGap,
} from "@autonomous-trading-lab/solana-chain-provider";
import type { FilteredTransactionRecord } from "@autonomous-trading-lab/solana-chain-provider";
import type { EntitySourceSnapshot } from "./entity-registry-source.js";
import type { NormalizedCapitalBatch } from "@autonomous-trading-lab/solana-normalization";
import type { CaptureFailure } from "./capture.js";
import type { RpcMintAssessment } from "./solana-rpc.js";
import type { RouteAssessment } from "./jupiter.js";
import type { MarketIntegrityAssessment } from "./jupiter-token.js";
import { deterministicDomainId } from "./ids.js";
import type { CaptureRecord } from "./schemas.js";
import { createSqlDatabase, type SqlDatabase, type SqlTransaction } from "./database-client.js";
import { classifyEntityBehavior, type EntityBehaviorHeuristic } from "./entity-candidates.js";
import { EntityVerificationReviewSchema, type EntityVerificationReview } from "./entity-review.js";
import { classifyPumpSwapFlowWindow } from "./protocol-flow.js";
import {
  classifyAlertIntelligence,
  summarizeAlertIntelligence,
  type AlertIntelligence,
  type AlertIntelligenceSummary,
} from "./alert-intelligence.js";
import type { SolanaTokenAccountOwnerObservation } from "./solana-owner-extraction.js";

interface MigrationRow {
  readonly name: string;
  readonly checksum: string;
}

export const toIsoTimestamp = (value: Date | string): string => {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime()))
    throw new Error(`invalid database timestamp: ${String(value)}`);
  return timestamp.toISOString();
};

const encodedRawObject = (
  value: unknown,
): {
  readonly compressed: Uint8Array;
  readonly exact: string;
  readonly projection: string;
} => {
  const exact = JSON.stringify(value);
  return {
    // Capture is on the chain-head critical path; fast gzip keeps it bounded while retaining
    // content-addressed compression. Offline compaction can optimize cold objects later.
    compressed: gzipSync(Buffer.from(exact, "utf8"), { level: 1 }),
    exact,
    projection: exact.replaceAll("\\u0000", "\\ufffd"),
  };
};

const countSignificantCells = (value: unknown): number =>
  Array.isArray(value)
    ? value.filter(
        (cell: unknown) =>
          typeof cell === "object" &&
          cell !== null &&
          "significant" in cell &&
          cell.significant === true,
      ).length
    : 0;

async function persistRawObject(
  transaction: SqlTransaction,
  objectHash: `sha256:${string}`,
  value: unknown,
  createdAt: string,
): Promise<boolean> {
  const encoded = encodedRawObject(value);
  const result = await transaction.query(
    `INSERT INTO raw_objects
      (object_hash, media_type, encoding, payload, uncompressed_bytes, compressed_bytes, created_at)
     VALUES ($1,'application/json','GZIP_JSON_V1',$2,$3,$4,$5)
     ON CONFLICT (object_hash) DO NOTHING`,
    [
      objectHash,
      encoded.compressed,
      Buffer.byteLength(encoded.exact, "utf8"),
      encoded.compressed.byteLength,
      createdAt,
    ],
  );
  return (result.affectedRows ?? 0) > 0;
}

export interface CollectionRunSummary {
  readonly collectionRunId: string;
  readonly source: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly requestedAssets: number;
  readonly capturedObservations: number;
  readonly errorCount: number;
  readonly status: "COMPLETED" | "PARTIAL" | "FAILED";
  readonly details: Readonly<Record<string, unknown>>;
}

export interface CapitalBatchPersistenceResult {
  readonly rawObservationsInserted: number;
  readonly rawBlocksInserted: number;
  readonly assetsInserted: number;
  readonly entitiesInserted: number;
  readonly eventsInserted: number;
}

export interface EnrichmentAblationEvaluationRow {
  readonly eventId: string;
  readonly eventTime: string;
  readonly returnPct: number;
  readonly normalSolReturnPct: number;
  readonly btcReturnPct: number | null;
  readonly quantity: number;
  readonly nansenScore: number | null;
  readonly regime: string;
  readonly magnitudeBucket: string;
}

export interface EntityVerificationCandidate {
  readonly rank: number;
  readonly entityId: string;
  readonly address?: string;
  readonly eventCount: number;
  readonly uniqueCounterpartyCount: number;
  readonly inflowEventCount: number;
  readonly outflowEventCount: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly behaviorHeuristic: EntityBehaviorHeuristic;
  readonly identityStatus: "UNKNOWN" | "VERIFIED";
  readonly verifiedIdentity?: {
    readonly label: string;
    readonly entityType: string;
    readonly source: string;
    readonly sourceUrl: string;
  };
}

export interface StoredEntityVerificationReview extends EntityVerificationReview {
  readonly reviewId: string;
}

export interface SolanaOwnerExtractionResult {
  readonly rawObjectHash: `sha256:${string}`;
  readonly observationCount: number;
  readonly insertedObservationCount: number;
}

export interface EntityActivityRollupResult {
  readonly runId: string;
  readonly datasetCutoff: string;
  readonly generatedAt: string;
  readonly addressCount: number;
  readonly endpointEventCount: number;
}

export interface EntityAttributionQualityReport {
  readonly observedAt: string;
  readonly archivedBlockCount: number;
  readonly extractedBlockCount: number;
  readonly extractionCoveragePct: number;
  readonly correctedEndpointCount: number;
  readonly distinctTokenAccountCount: number;
  readonly distinctOwnerCount: number;
  readonly rollupRunId?: string;
  readonly rollupDatasetCutoff?: string;
  readonly rolledUpAddressCount: number;
  readonly rolledUpEndpointCount: number;
  readonly verifiedRolledUpAddressCount: number;
  readonly verifiedRolledUpEndpointCount: number;
  readonly verifiedEndpointCoveragePct: number;
}

export interface ProtocolFlowMaterializationResult {
  readonly eligibleWindowCount: number;
  readonly insertedWindowCount: number;
  readonly earliestWindowStart?: string;
  readonly latestWindowStart?: string;
}

export interface ProtocolFlowSummary {
  readonly protocolKey: string;
  readonly windowCount: number;
  readonly totalEventCount: number;
  readonly latestWindowStart?: string;
  readonly latestEventCount?: number;
  readonly latestDistinctCounterpartyCount?: number;
  readonly latestNativeSolQuantity?: string;
  readonly latestWrappedSolQuantity?: string;
  readonly latestEventCountZScore?: string;
  readonly matureOutcomeCount: number;
  readonly benchmarkOutcomeCount: number;
  readonly matureWindowCount: number;
  readonly baselineReadyWindowCount: number;
  readonly analysisReadyWindowCount: number;
}

export interface PumpSwapProtocolReadiness {
  readonly registered: boolean;
  readonly protocolId?: string;
  readonly frozenAt?: string;
  readonly datasetCutoff?: string;
  readonly minimumSampleSize?: number;
  readonly holdoutFraction?: number;
  readonly holdoutAccessCount: number;
  readonly holdoutSealed: boolean;
  readonly latestRunAt?: string;
  readonly latestRunStatus?: "COMPLETE" | "INSUFFICIENT_DATA";
  readonly latestObservationCount: number;
  readonly randomizedTimestampTrials: number;
}

export interface FilteredTransactionReconciliation {
  readonly providerId: string;
  readonly filterId: string;
  readonly signature: string;
  readonly status: "FINALIZED" | "MISSING" | "FAILED";
  readonly reconciledAt: string;
  readonly finalizedBlockHash?: string;
  readonly detail?: string;
}

export interface FilteredStreamCheckpoint {
  readonly providerId: string;
  readonly filterId: string;
  readonly highestReceivedSlot?: string;
  readonly highestReconciledSlot?: string;
  readonly reconnectCount: number;
  readonly lastConnectedAt?: string;
  readonly lastDisconnectedAt?: string;
  readonly lastError?: string;
  readonly updatedAt: string;
}

export interface PendingFilteredTransaction {
  readonly providerId: string;
  readonly filterId: string;
  readonly slot: string;
  readonly signature: string;
  readonly receivedAt: string;
}

export interface FilteredTransactionNormalizationResult {
  readonly providerId: string;
  readonly filterId: string;
  readonly signature: string;
  readonly parserVersion: number;
  readonly rawBlockHash: `sha256:${string}`;
  readonly eventCount: number;
  readonly normalizedAt: string;
  readonly eventIds: readonly string[];
}

export interface FilteredCapitalAlert {
  readonly providerId: string;
  readonly filterId: string;
  readonly signature: string;
  readonly slot: string;
  readonly receivedAt: string;
  readonly reconciliationStatus: "PENDING" | "FINALIZED" | "MISSING" | "FAILED";
  readonly normalizedAt?: string;
  readonly summary: AlertIntelligenceSummary;
  readonly capitalEvents: readonly {
    readonly eventId: string;
    readonly eventTime: string;
    readonly quantity: string;
    readonly assetId: string;
    readonly venueLabel?: string;
    readonly fromLabel?: string;
    readonly fromEntityType?: string;
    readonly toLabel?: string;
    readonly toEntityType?: string;
    readonly outcomes: readonly { readonly horizon: string; readonly returnPct: string }[];
    readonly marketReactions: readonly {
      readonly windowSeconds: number;
      readonly venue: string;
      readonly instrumentId: string;
      readonly features: MarketReactionFeatures;
    }[];
    readonly walletHistory: {
      readonly priorTransferCount: number;
      readonly quantityZScore?: number;
      readonly dormantDays?: number;
    };
    readonly intelligence: AlertIntelligence;
  }[];
}

export interface ChainNormalizationJob {
  readonly rawObjectHash: `sha256:${string}`;
  readonly parserVersion: number;
  readonly providerId: string;
  readonly chain: string;
  readonly slot: string;
  readonly attempts: number;
  readonly createdAt: string;
}

export interface ChainNormalizationFailureResult {
  readonly status: "PENDING" | "FAILED";
  readonly attempts: number;
}

export interface HistoricalMarketRecord {
  readonly event: MarketEvent;
  readonly productId: string;
  readonly messageType: string;
  readonly payload: unknown;
}

export interface CollectionServiceLease {
  readonly serviceName: string;
  readonly ownerId: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly leaseExpiresAt: string;
  readonly status: "RUNNING" | "STOPPED" | "FAILED";
  readonly lastError?: string;
}

export interface ReferenceInstrumentDescriptor {
  readonly venue: string;
  readonly instrumentId: string;
  readonly baseAsset: string;
  readonly quoteAsset: "USD" | "USDT";
}

export interface ChainNormalizationQueueStatus {
  readonly pending: number;
  readonly processing: number;
  readonly complete: number;
  readonly failed: number;
  readonly oldestPendingAt?: string;
}

export interface RawRetentionResult {
  readonly retentionRunId: string;
  readonly cutoffAt: string;
  readonly executedAt: string;
  readonly maximumObjects: number;
  readonly objectsDeleted: number;
  readonly compressedBytesDeleted: number;
  readonly chainBlocksDeleted: number;
  readonly marketMessagesDeleted: number;
  readonly normalizationJobsDeleted: number;
  readonly rawObservationLinksCleared: number;
}

export interface ResearchAnalysisRun {
  readonly runId: string;
  readonly protocolId: string;
  readonly analysisFamily:
    | "TRANSFER_MAGNITUDE"
    | "TRANSFER_MAGNITUDE_BTC_RELATIVE"
    | "CAPITAL_FLOW_EPISODE_BTC_RELATIVE"
    | "DIRECTION"
    | "WALLET_BEHAVIOR"
    | "MARKET_REACTION"
    | "CONDITIONAL_COMBINATION"
    | "PROTOCOL_FLOW";
  readonly analysisVersion: number;
  readonly generatedAt: string;
  readonly codeHash: `sha256:${string}`;
  readonly datasetHash: `sha256:${string}`;
  readonly qualityManifestId?: string;
  readonly result: TransferMagnitudeAnalysis | CategoricalFlowAnalysis;
}

export interface PersistedMarketReaction {
  readonly featureId: string;
  readonly capitalEventId: string;
  readonly venue: string;
  readonly instrumentId: string;
  readonly windowSeconds: number;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly beforeSnapshotHash: `sha256:${string}`;
  readonly afterSnapshotHash: `sha256:${string}`;
  readonly features: MarketReactionFeatures;
  readonly contentHash: `sha256:${string}`;
}

export interface CapitalEventDetail {
  readonly event: CapitalEvent;
  readonly fromEntity?: {
    readonly entityId: string;
    readonly addresses: readonly string[];
    readonly label?: string;
    readonly entityType?: string;
    readonly attributionSource?: string;
  };
  readonly toEntity?: {
    readonly entityId: string;
    readonly addresses: readonly string[];
    readonly label?: string;
    readonly entityType?: string;
    readonly attributionSource?: string;
  };
  readonly protocol?: {
    readonly address: string;
    readonly label: string;
    readonly entityType: string;
    readonly source: string;
  };
  readonly outcomes: readonly {
    readonly horizon: string;
    readonly exitAt: string;
    readonly returnPct: string;
    readonly maximumFavorableExcursionPct: string;
    readonly maximumAdverseExcursionPct: string;
  }[];
  readonly marketReactions: readonly PersistedMarketReaction[];
}

export interface OperationalHealthSnapshot {
  readonly observedAt: string;
  readonly status: "HEALTHY" | "DEGRADED" | "UNHEALTHY";
  readonly latestChainBlockAt?: string;
  readonly latestChainIngestedAt?: string;
  readonly latestMarketMessageAt?: string;
  readonly chainAgeSeconds?: number;
  readonly marketAgeSeconds?: number;
  readonly recentMarketIncidents: number;
  readonly activeMarketIncidents: number;
  readonly pendingFilteredReconciliations: number;
  readonly failedFilteredReconciliations: number;
  readonly queue: ChainNormalizationQueueStatus;
  readonly reasons: readonly string[];
}

export interface CfieDemoReport {
  readonly generatedAt: string;
  readonly authority: "READ_ONLY_RESEARCH";
  readonly dashboardSampleEventLimit: number;
  readonly counts: {
    readonly rawObjects: number;
    readonly chainBlocks: number;
    readonly capitalEvents: number;
    readonly entities: number;
    readonly assets: number;
    readonly marketEvents: number;
    readonly rawMarketMessages: number;
    readonly evidencePackets: number;
    readonly marketDataIncidents: number;
    readonly referencePriceSnapshots: number;
    readonly capitalEventForwardOutcomes: number;
    readonly capitalEventBenchmarkOutcomes: number;
    readonly marketReactionFeatures: number;
    readonly marketRegimeSnapshots: number;
    readonly capitalFlowEpisodes: number;
    readonly verifiedEntityAddresses: number;
    readonly filteredTransactions: number;
    readonly reconciledFilteredTransactions: number;
    readonly normalizedFilteredTransactions: number;
    readonly researchAnalysisRuns: number;
  };
  readonly entityAttribution: {
    readonly endpointCount: number;
    readonly verifiedEndpointCount: number;
    readonly coveragePct: number;
  };
  readonly entityRegistryQuality: {
    readonly addressCount: number;
    readonly sourceCount: number;
    readonly singleSourceAddressCount: number;
    readonly conflictingAddressCount: number;
  };
  readonly filteredStream: {
    readonly pending: number;
    readonly finalized: number;
    readonly missing: number;
    readonly failed: number;
    readonly normalized: number;
    readonly linkedCapitalEvents: number;
    readonly latestReceivedAt?: string;
    readonly latestReconciledAt?: string;
  };
  readonly normalizationQueue: ChainNormalizationQueueStatus;
  readonly operationalHealth: OperationalHealthSnapshot;
  readonly collectionService: {
    readonly status: "RUNNING" | "STOPPED" | "FAILED" | "NOT_CONFIGURED";
    readonly serviceName?: string;
    readonly startedAt?: string;
    readonly heartbeatAt?: string;
    readonly leaseExpiresAt?: string;
    readonly lastError?: string;
  };
  readonly horizonMaturation: readonly {
    readonly horizon: string;
    readonly windowSeconds: number;
    readonly outcomeCount: number;
    readonly reactionCount: number;
    readonly uniqueReactionTimestampCount: number;
    readonly benchmarkOutcomeCount: number;
  }[];
  readonly latestMarketRegime?: MarketRegimeResult;
  readonly episodeReadiness: {
    readonly episodeCount: number;
    readonly underlyingEventCount: number;
    readonly averageEventsPerEpisode: number;
    readonly attributedEpisodeCount: number;
  };
  readonly recentCapitalFlowEpisodes: readonly {
    readonly episodeId: string;
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly eventCount: number;
    readonly totalQuantity: string;
    readonly maximumQuantity: string;
    readonly dominantCohort: string;
    readonly verifiedVenueEventCount: number;
    readonly primaryVenueLabel?: string;
    readonly primaryVenueEntityType?: string;
  }[];
  readonly recentIncidentSummary: readonly {
    readonly incidentType: string;
    readonly venue: string;
    readonly productId: string;
    readonly count: number;
    readonly firstDetectedAt: string;
    readonly lastDetectedAt: string;
  }[];
  readonly collectionGapSummary: {
    readonly gapCount: number;
    readonly skippedSlotCount: number;
    readonly largestGapSlots: number;
    readonly liveTailFastForwardCount: number;
    readonly latestDetectedAt?: string;
  };
  readonly recentCapitalEvents: readonly {
    readonly eventId: string;
    readonly eventTime: string;
    readonly eventType: string;
    readonly assetId: string;
    readonly quantity: string;
    readonly venue?: string;
    readonly venueLabel?: string;
    readonly venueEntityType?: string;
    readonly fromEntityId?: string;
    readonly toEntityId?: string;
    readonly fromLabel?: string;
    readonly toLabel?: string;
    readonly fromEntityType?: string;
    readonly toEntityType?: string;
  }[];
  readonly recentMarketEvents: readonly {
    readonly eventId: string;
    readonly eventTime: string;
    readonly instrumentId: string;
    readonly eventType: string;
    readonly price?: string;
    readonly quantity?: string;
    readonly side?: string;
  }[];
  readonly recentEvidencePackets: readonly {
    readonly packetId: string;
    readonly detectedEventId: string;
    readonly generatedAt: string;
    readonly action: "HUMAN_REVIEW";
    readonly dataQuality: "COMPLETE" | "PARTIAL" | "DEGRADED";
    readonly confidence: number;
    readonly contradictionCount: number;
  }[];
  readonly recentReferencePrices: readonly ReferencePriceEstimate[];
  readonly recentCapitalOutcomes: readonly {
    readonly eventId: string;
    readonly horizon: string;
    readonly eventAt: string;
    readonly exitAt: string;
    readonly returnPct: string;
    readonly maximumFavorableExcursionPct: string;
    readonly maximumAdverseExcursionPct: string;
  }[];
  readonly recentRetentionRuns: readonly RawRetentionResult[];
  readonly recentResearchRuns: readonly {
    readonly runId: string;
    readonly protocolId: string;
    readonly analysisFamily: string;
    readonly generatedAt: string;
    readonly status: string;
    readonly observationCount: number;
    readonly significantCellCount: number;
    readonly validationVerdict:
      | "INSUFFICIENT_DATA"
      | "PARTIAL_NO_DEVELOPMENT_FINDING"
      | "NO_DEVELOPMENT_FINDING"
      | "HOLDOUT_UNDERPOWERED"
      | "FAILED_HOLDOUT"
      | "HOLDOUT_REPLICATED";
    readonly eligibleHoldoutCount: number;
    readonly replicatedHoldoutCount: number;
    readonly falsificationControl?: string;
    readonly falsificationTestedCount?: number;
    readonly falsificationSurvivingCount?: number;
    readonly falsificationControls: readonly {
      readonly control: string;
      readonly testedCount: number;
      readonly survivingCount: number;
      readonly trialCount?: number;
    }[];
  }[];
  readonly directionalOutcomes: readonly {
    readonly fromClass: string;
    readonly toClass: string;
    readonly horizon: string;
    readonly sampleSize: number;
    readonly meanReturnPct: string;
  }[];
  readonly protocolInteractionOutcomes: readonly {
    readonly venue: string;
    readonly venueLabel: string;
    readonly venueEntityType: string;
    readonly horizon: string;
    readonly sampleSize: number;
    readonly meanReturnPct: string;
  }[];
}

export class ResearchDatabase {
  readonly #database: SqlDatabase;

  public constructor(location: string) {
    this.#database = createSqlDatabase(location);
  }

  public async migrate(migrationsDirectory: string): Promise<void> {
    await this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Migration names are controlled repository files and sorted for deterministic application.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const names = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
      .sort();
    for (const name of names) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const sql = await readFile(join(migrationsDirectory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const applied = await this.#database.query<MigrationRow>(
        "SELECT name, checksum FROM schema_migrations WHERE name = $1",
        [name],
      );
      const existing = applied.rows[0];
      if (existing) {
        if (existing.checksum !== checksum) throw new Error(`applied migration changed: ${name}`);
        continue;
      }
      try {
        await this.#database.exec(sql);
        await this.#database.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [name, checksum],
        );
      } catch (error: unknown) {
        // Dashboard and collector may start together. If the peer is applying the same
        // transactional migration, wait for its immutable ledger entry instead of racing DDL.
        let peer: MigrationRow | undefined;
        for (let attempt = 0; attempt < 20 && !peer; attempt += 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          const result = await this.#database.query<MigrationRow>(
            "SELECT name, checksum FROM schema_migrations WHERE name = $1",
            [name],
          );
          peer = result.rows[0];
        }
        if (!peer) throw error;
        if (peer.checksum !== checksum)
          throw new Error(`applied migration changed: ${name}`, { cause: error });
      }
    }
  }

  public async persistEnrichmentClaim(candidate: EnrichmentClaim): Promise<boolean> {
    const claim = EnrichmentClaimSchema.parse(candidate);
    const recordHash = contentHash(claim);
    const result = await this.#database.query(
      `INSERT INTO enrichment_claims
        (claim_id, subject_id, claim_type, claim_value, provider, confidence, evidence_refs,
         valid_from, valid_to, retrieved_at, schema_version, record_hash)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)
       ON CONFLICT (claim_id) DO NOTHING`,
      [
        claim.claimId,
        claim.subjectId,
        claim.claimType,
        JSON.stringify(claim.value),
        claim.provider,
        claim.confidence,
        JSON.stringify(claim.evidenceRefs),
        claim.validFrom ?? null,
        claim.validTo ?? null,
        claim.retrievedAt,
        Number(claim.schemaVersion),
        recordHash,
      ],
    );
    const inserted = (result.affectedRows ?? 0) > 0;
    if (!inserted) {
      const existing = await this.#database.query<{ record_hash: string }>(
        "SELECT record_hash FROM enrichment_claims WHERE claim_id = $1",
        [claim.claimId],
      );
      if (existing.rows[0]?.record_hash !== recordHash)
        throw new Error(`enrichment claim identity collision: ${claim.claimId}`);
    }
    return inserted;
  }

  public async pointInTimeEnrichmentClaims(
    subjectId: string,
    claimType: string,
    asOf: string,
  ): Promise<readonly EnrichmentClaim[]> {
    const result = await this.#database.query<{
      claim_id: string;
      subject_id: string;
      claim_type: string;
      claim_value: string | number | boolean | null;
      provider: string;
      confidence: string | number;
      evidence_refs: `sha256:${string}`[];
      valid_from: Date | string | null;
      valid_to: Date | string | null;
      retrieved_at: Date | string;
      schema_version: number;
    }>(
      `SELECT claim_id, subject_id, claim_type, claim_value, provider, confidence,
              evidence_refs, valid_from, valid_to, retrieved_at, schema_version
       FROM enrichment_claims
       WHERE subject_id = $1 AND claim_type = $2 AND retrieved_at <= $3
         AND (valid_from IS NULL OR valid_from <= $3)
         AND (valid_to IS NULL OR valid_to >= $3)
       ORDER BY confidence DESC, retrieved_at DESC, claim_id`,
      [subjectId, claimType, asOf],
    );
    return result.rows.map((row) =>
      EnrichmentClaimSchema.parse({
        claimId: row.claim_id,
        subjectId: row.subject_id,
        claimType: row.claim_type,
        value: row.claim_value,
        provider: row.provider,
        confidence: Number(row.confidence),
        evidenceRefs: row.evidence_refs,
        ...(row.valid_from === null ? {} : { validFrom: toIsoTimestamp(row.valid_from) }),
        ...(row.valid_to === null ? {} : { validTo: toIsoTimestamp(row.valid_to) }),
        retrievedAt: toIsoTimestamp(row.retrieved_at),
        schemaVersion: String(row.schema_version),
      }),
    );
  }

  public async persistVerifiedEntityAddress(candidate: VerifiedEntityAddress): Promise<boolean> {
    return (await this.persistVerifiedEntityAddresses([candidate])).inserted === 1;
  }

  public async persistEntitySourceSnapshot(candidate: EntitySourceSnapshot): Promise<boolean> {
    if (contentHash(candidate.body) !== candidate.evidenceHash)
      throw new Error("entity source snapshot evidence hash mismatch");
    if (Buffer.byteLength(candidate.body, "utf8") !== candidate.byteCount)
      throw new Error("entity source snapshot byte count mismatch");
    const identity = {
      sourceId: candidate.sourceId,
      sourceUrl: candidate.sourceUrl,
      retrievedAt: candidate.retrievedAt,
      evidenceHash: candidate.evidenceHash,
      byteCount: candidate.byteCount,
    };
    const recordHash = contentHash(identity);
    return this.#database.transaction(async (transaction) => {
      await persistRawObject(
        transaction,
        candidate.evidenceHash,
        candidate.body,
        candidate.retrievedAt,
      );
      const result = await transaction.query(
        `INSERT INTO entity_source_snapshots
          (source_id, source_url, retrieved_at, evidence_hash, raw_object_hash, byte_count, record_hash)
         VALUES ($1,$2,$3,$4,$4,$5,$6)
         ON CONFLICT (source_id, evidence_hash) DO NOTHING`,
        [
          candidate.sourceId,
          candidate.sourceUrl,
          candidate.retrievedAt,
          candidate.evidenceHash,
          candidate.byteCount,
          recordHash,
        ],
      );
      return (result.affectedRows ?? 0) > 0;
    });
  }

  public async persistVerifiedEntityAddresses(
    candidates: readonly VerifiedEntityAddress[],
  ): Promise<{ readonly accepted: number; readonly inserted: number }> {
    if (candidates.length > 100_000)
      throw new Error("entity registry batch exceeds 100000 records");
    const records = candidates.map((candidate) => VerifiedEntityAddressSchema.parse(candidate));
    const identities = new Set<string>();
    for (const record of records) {
      const identity = `${record.address}:${record.validFrom}`;
      if (identities.has(identity)) throw new Error(`duplicate registry identity: ${identity}`);
      identities.add(identity);
    }
    return this.#database.transaction(async (transaction) => {
      let inserted = 0;
      for (const record of records) {
        const recordHash = contentHash(record);
        const unchangedEvidence = await transaction.query<{ present: number }>(
          `SELECT 1 AS present FROM verified_entity_addresses
           WHERE address = $1 AND entity_type = $2 AND label = $3 AND source = $4
             AND evidence_hash = $5 AND valid_to IS NOT DISTINCT FROM $6::timestamptz
           LIMIT 1`,
          [
            record.address,
            record.entityType,
            record.label,
            record.source,
            record.evidenceHash,
            record.validTo ?? null,
          ],
        );
        if (unchangedEvidence.rows.length > 0) continue;
        const overlaps = await transaction.query<{ entity_type: string; label: string }>(
          `SELECT entity_type, label FROM verified_entity_addresses
           WHERE address = $1
             AND valid_from <= COALESCE($2, '9999-12-31T23:59:59.999Z'::timestamptz)
             AND (valid_to IS NULL OR valid_to >= $3)`,
          [record.address, record.validTo ?? null, record.validFrom],
        );
        if (
          overlaps.rows.some(
            (overlap) =>
              overlap.entity_type !== record.entityType || overlap.label !== record.label,
          )
        )
          throw new Error(`conflicting verified attribution overlap: ${record.address}`);
        const result = await transaction.query(
          `INSERT INTO verified_entity_addresses
            (address, entity_type, label, source, source_url, evidence_hash, valid_from, valid_to,
             retrieved_at, schema_version, record_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (address, valid_from) DO NOTHING`,
          [
            record.address,
            record.entityType,
            record.label,
            record.source,
            record.sourceUrl,
            record.evidenceHash,
            record.validFrom,
            record.validTo ?? null,
            record.retrievedAt,
            Number(record.schemaVersion),
            recordHash,
          ],
        );
        if ((result.affectedRows ?? 0) > 0) {
          inserted += 1;
          continue;
        }
        const existing = await transaction.query<{ record_hash: string }>(
          "SELECT record_hash FROM verified_entity_addresses WHERE address = $1 AND valid_from = $2",
          [record.address, record.validFrom],
        );
        if (existing.rows[0]?.record_hash !== recordHash)
          throw new Error(`verified entity address identity collision: ${record.address}`);
      }
      return { accepted: records.length, inserted };
    });
  }

  public async verifiedEntityAddressAt(
    address: string,
    asOf: string,
  ): Promise<VerifiedEntityAddress | undefined> {
    const result = await this.#database.query<{
      address: string;
      entity_type: VerifiedEntityAddress["entityType"];
      label: string;
      source: string;
      source_url: string;
      evidence_hash: `sha256:${string}`;
      valid_from: Date | string;
      valid_to: Date | string | null;
      retrieved_at: Date | string;
      schema_version: number;
    }>(
      `SELECT address, entity_type, label, source, source_url, evidence_hash, valid_from, valid_to,
              retrieved_at, schema_version
       FROM verified_entity_addresses
       WHERE address = $1 AND retrieved_at <= $2 AND valid_from <= $2
         AND (valid_to IS NULL OR valid_to >= $2)
       ORDER BY valid_from DESC, retrieved_at DESC LIMIT 1`,
      [address, asOf],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return VerifiedEntityAddressSchema.parse({
      address: row.address,
      entityType: row.entity_type,
      label: row.label,
      source: row.source,
      sourceUrl: row.source_url,
      evidenceHash: row.evidence_hash,
      validFrom: toIsoTimestamp(row.valid_from),
      ...(row.valid_to === null ? {} : { validTo: toIsoTimestamp(row.valid_to) }),
      retrievedAt: toIsoTimestamp(row.retrieved_at),
      schemaVersion: String(row.schema_version),
    });
  }

  public async persistFilteredTransaction(candidate: FilteredTransactionRecord): Promise<boolean> {
    if (!/^(0|[1-9][0-9]*)$/.test(candidate.slot))
      throw new Error("filtered transaction slot is invalid");
    if (!Number.isInteger(candidate.parserVersion) || candidate.parserVersion < 1)
      throw new Error("filtered transaction parser version is invalid");
    const rawObjectHash = contentHash(candidate.payload);
    return this.#database.transaction(async (transaction) => {
      await persistRawObject(transaction, rawObjectHash, candidate.payload, candidate.receivedAt);
      const result = await transaction.query(
        `INSERT INTO raw_filtered_transactions
          (provider_id, filter_id, subscription_id, slot, signature, received_at, commitment,
           parser_version, payload, payload_hash, raw_object_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$10)
         ON CONFLICT (provider_id, filter_id, signature) DO NOTHING`,
        [
          candidate.providerId,
          candidate.filterId,
          candidate.subscriptionId,
          candidate.slot,
          candidate.signature,
          candidate.receivedAt,
          candidate.commitment,
          candidate.parserVersion,
          JSON.stringify(candidate.payload),
          rawObjectHash,
        ],
      );
      if ((result.affectedRows ?? 0) > 0) return true;
      const existing = await transaction.query<{ payload_hash: string; slot: string | number }>(
        `SELECT payload_hash, slot FROM raw_filtered_transactions
         WHERE provider_id = $1 AND filter_id = $2 AND signature = $3`,
        [candidate.providerId, candidate.filterId, candidate.signature],
      );
      const row = existing.rows[0];
      if (row?.payload_hash !== rawObjectHash || String(row.slot) !== candidate.slot)
        throw new Error(`filtered transaction identity collision: ${candidate.signature}`);
      return false;
    });
  }

  public async persistFilteredTransactionReconciliation(
    candidate: FilteredTransactionReconciliation,
  ): Promise<boolean> {
    if (candidate.status === "FINALIZED" && !candidate.finalizedBlockHash)
      throw new Error("finalized reconciliation requires a block hash");
    const recordHash = contentHash(candidate);
    const result = await this.#database.query(
      `INSERT INTO filtered_transaction_reconciliations
        (provider_id, filter_id, signature, status, reconciled_at, finalized_block_hash, detail, record_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (provider_id, filter_id, signature) DO NOTHING`,
      [
        candidate.providerId,
        candidate.filterId,
        candidate.signature,
        candidate.status,
        candidate.reconciledAt,
        candidate.finalizedBlockHash ?? null,
        candidate.detail ?? null,
        recordHash,
      ],
    );
    if ((result.affectedRows ?? 0) > 0) return true;
    const existing = await this.#database.query<{ record_hash: string }>(
      `SELECT record_hash FROM filtered_transaction_reconciliations
       WHERE provider_id = $1 AND filter_id = $2 AND signature = $3`,
      [candidate.providerId, candidate.filterId, candidate.signature],
    );
    if (existing.rows[0]?.record_hash !== recordHash)
      throw new Error(`filtered reconciliation identity collision: ${candidate.signature}`);
    return false;
  }

  public async pendingFilteredTransactions(
    limit: number,
  ): Promise<readonly PendingFilteredTransaction[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
      throw new Error("pending filtered transaction limit must be between 1 and 10000");
    const result = await this.#database.query<{
      provider_id: string;
      filter_id: string;
      slot: string | number;
      signature: string;
      received_at: Date | string;
    }>(
      `SELECT transaction.provider_id, transaction.filter_id, transaction.slot,
              transaction.signature, transaction.received_at
       FROM raw_filtered_transactions transaction
       LEFT JOIN filtered_transaction_reconciliations reconciliation
         ON reconciliation.provider_id = transaction.provider_id
        AND reconciliation.filter_id = transaction.filter_id
        AND reconciliation.signature = transaction.signature
       WHERE reconciliation.signature IS NULL
       ORDER BY transaction.slot, transaction.signature
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      providerId: row.provider_id,
      filterId: row.filter_id,
      slot: String(row.slot),
      signature: row.signature,
      receivedAt: toIsoTimestamp(row.received_at),
    }));
  }

  public async filteredTransactionNormalization(
    providerId: string,
    filterId: string,
    signature: string,
    parserVersion: number,
  ): Promise<FilteredTransactionNormalizationResult | undefined> {
    const result = await this.#database.query<{
      provider_id: string;
      filter_id: string;
      signature: string;
      parser_version: number;
      raw_block_hash: `sha256:${string}`;
      event_count: number;
      normalized_at: Date | string;
      event_ids: readonly string[] | null;
    }>(
      `SELECT normalization.provider_id, normalization.filter_id, normalization.signature,
              normalization.parser_version, normalization.raw_block_hash,
              normalization.event_count, normalization.normalized_at,
              array_remove(array_agg(link.event_id ORDER BY link.event_id), NULL) AS event_ids
       FROM filtered_transaction_normalizations normalization
       LEFT JOIN filtered_transaction_capital_events link
         ON link.provider_id = normalization.provider_id
        AND link.filter_id = normalization.filter_id
        AND link.signature = normalization.signature
        AND link.parser_version = normalization.parser_version
       WHERE normalization.provider_id = $1 AND normalization.filter_id = $2
         AND normalization.signature = $3 AND normalization.parser_version = $4
       GROUP BY normalization.provider_id, normalization.filter_id, normalization.signature,
                normalization.parser_version, normalization.raw_block_hash,
                normalization.event_count, normalization.normalized_at`,
      [providerId, filterId, signature, parserVersion],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      providerId: row.provider_id,
      filterId: row.filter_id,
      signature: row.signature,
      parserVersion: row.parser_version,
      rawBlockHash: row.raw_block_hash,
      eventCount: row.event_count,
      normalizedAt: toIsoTimestamp(row.normalized_at),
      eventIds: row.event_ids ?? [],
    };
  }

  public async linkExistingFinalizedFilteredTransactions(
    limit: number,
    parserVersion = 3,
    normalizedAt = new Date().toISOString(),
  ): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
      throw new Error("filtered normalization link limit must be between 1 and 10000");
    if (!Number.isInteger(parserVersion) || parserVersion < 1)
      throw new Error("filtered normalization parser version is invalid");
    return this.#database.transaction(async (transaction) => {
      const candidates = await transaction.query<{
        provider_id: string;
        filter_id: string;
        signature: string;
        raw_block_hash: `sha256:${string}`;
      }>(
        `SELECT reconciliation.provider_id, reconciliation.filter_id,
                reconciliation.signature, block.raw_object_hash AS raw_block_hash
         FROM filtered_transaction_reconciliations reconciliation
         JOIN raw_filtered_transactions filtered
           ON filtered.provider_id = reconciliation.provider_id
          AND filtered.filter_id = reconciliation.filter_id
          AND filtered.signature = reconciliation.signature
         JOIN raw_chain_blocks block
           ON block.provider_id = 'solana-rpc' AND block.chain = 'solana'
          AND block.slot = filtered.slot
         JOIN chain_normalization_jobs job
           ON job.raw_object_hash = block.raw_object_hash
          AND job.parser_version = $2 AND job.status = 'COMPLETE'
         LEFT JOIN filtered_transaction_normalizations normalization
           ON normalization.provider_id = reconciliation.provider_id
          AND normalization.filter_id = reconciliation.filter_id
          AND normalization.signature = reconciliation.signature
          AND normalization.parser_version = $2
         WHERE reconciliation.status = 'FINALIZED' AND normalization.signature IS NULL
         ORDER BY filtered.slot, reconciliation.signature
         LIMIT $1`,
        [limit, parserVersion],
      );
      const events =
        candidates.rows.length === 0
          ? { rows: [] as { transaction_hash: string; event_id: string }[] }
          : await transaction.query<{ transaction_hash: string; event_id: string }>(
              `SELECT transaction_hash, event_id
               FROM capital_events
               WHERE transaction_hash IN (SELECT jsonb_array_elements_text($1::jsonb))
               ORDER BY transaction_hash, event_id`,
              [JSON.stringify(candidates.rows.map((candidate) => candidate.signature))],
            );
      const eventIdsBySignature = new Map<string, string[]>();
      for (const event of events.rows) {
        const eventIds = eventIdsBySignature.get(event.transaction_hash) ?? [];
        eventIds.push(event.event_id);
        eventIdsBySignature.set(event.transaction_hash, eventIds);
      }
      let linked = 0;
      for (const candidate of candidates.rows) {
        const eventIds = eventIdsBySignature.get(candidate.signature) ?? [];
        const normalization = {
          providerId: candidate.provider_id,
          filterId: candidate.filter_id,
          signature: candidate.signature,
          parserVersion,
          rawBlockHash: candidate.raw_block_hash,
          eventCount: eventIds.length,
          normalizedAt,
        };
        const inserted = await transaction.query(
          `INSERT INTO filtered_transaction_normalizations
            (provider_id, filter_id, signature, parser_version, raw_block_hash, event_count,
             normalized_at, record_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (provider_id, filter_id, signature, parser_version) DO NOTHING`,
          [
            normalization.providerId,
            normalization.filterId,
            normalization.signature,
            normalization.parserVersion,
            normalization.rawBlockHash,
            normalization.eventCount,
            normalization.normalizedAt,
            contentHash(normalization),
          ],
        );
        if ((inserted.affectedRows ?? 0) === 0) continue;
        linked += 1;
        if (eventIds.length > 0)
          await transaction.query(
            `INSERT INTO filtered_transaction_capital_events
              (provider_id, filter_id, signature, parser_version, event_id)
             SELECT $1,$2,$3,$4,event_id
             FROM jsonb_array_elements_text($5::jsonb) event_id
             ON CONFLICT DO NOTHING`,
            [
              candidate.provider_id,
              candidate.filter_id,
              candidate.signature,
              parserVersion,
              JSON.stringify(eventIds),
            ],
          );
      }
      return linked;
    });
  }

  public async recentFilteredCapitalAlerts(limit = 20): Promise<readonly FilteredCapitalAlert[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("filtered alert limit must be between 1 and 100");
    const base = await this.#database.query<{
      provider_id: string;
      filter_id: string;
      signature: string;
      slot: string | number;
      received_at: Date | string;
      reconciliation_status: "FINALIZED" | "MISSING" | "FAILED" | null;
      normalized_at: Date | string | null;
    }>(
      `SELECT filtered.provider_id, filtered.filter_id, filtered.signature, filtered.slot,
              filtered.received_at, reconciliation.status AS reconciliation_status,
              normalization.normalized_at
       FROM raw_filtered_transactions filtered
       LEFT JOIN filtered_transaction_reconciliations reconciliation
         ON reconciliation.provider_id = filtered.provider_id
        AND reconciliation.filter_id = filtered.filter_id
        AND reconciliation.signature = filtered.signature
       LEFT JOIN filtered_transaction_normalizations normalization
         ON normalization.provider_id = filtered.provider_id
        AND normalization.filter_id = filtered.filter_id
        AND normalization.signature = filtered.signature
        AND normalization.parser_version = 3
       ORDER BY (normalization.normalized_at IS NOT NULL) DESC,
                EXISTS (
                  SELECT 1
                  FROM filtered_transaction_capital_events mature_link
                  JOIN capital_event_forward_outcomes mature_outcome
                    ON mature_outcome.event_id = mature_link.event_id
                  WHERE mature_link.provider_id = filtered.provider_id
                    AND mature_link.filter_id = filtered.filter_id
                    AND mature_link.signature = filtered.signature
                ) DESC,
                filtered.received_at DESC, filtered.signature DESC
       LIMIT $1`,
      [limit],
    );
    const signatures = base.rows.map((row) => row.signature);
    const linked =
      signatures.length === 0
        ? {
            rows: [] as {
              signature: string;
              event_id: string;
              event_time: Date | string;
              quantity: string;
              asset_id: string;
              venue_label: string | null;
              from_label: string | null;
              from_entity_type: string | null;
              to_label: string | null;
              to_entity_type: string | null;
              outcomes: unknown;
              prior_transfer_count: string | number;
              prior_quantity_mean: string | null;
              prior_quantity_stddev: string | null;
              previous_event_time: Date | string | null;
            }[],
          }
        : await this.#database.query<{
            signature: string;
            event_id: string;
            event_time: Date | string;
            quantity: string;
            asset_id: string;
            venue_label: string | null;
            from_label: string | null;
            from_entity_type: string | null;
            to_label: string | null;
            to_entity_type: string | null;
            outcomes: unknown;
            prior_transfer_count: string | number;
            prior_quantity_mean: string | null;
            prior_quantity_stddev: string | null;
            previous_event_time: Date | string | null;
          }>(
            `SELECT link.signature, event.event_id, event.event_time, event.quantity::text,
                    event.asset_id, venue.label AS venue_label,
                    from_attribution.label AS from_label,
                    from_attribution.entity_type AS from_entity_type,
                    to_attribution.label AS to_label,
                    to_attribution.entity_type AS to_entity_type,
                    COALESCE(outcomes.values, '[]'::jsonb) AS outcomes,
                    COALESCE(wallet_history.prior_transfer_count, 0) AS prior_transfer_count,
                    wallet_history.prior_quantity_mean::text AS prior_quantity_mean,
                    wallet_history.prior_quantity_stddev::text AS prior_quantity_stddev,
                    wallet_history.previous_event_time
             FROM filtered_transaction_capital_events link
             JOIN capital_events event ON event.event_id = link.event_id
             LEFT JOIN LATERAL (
               SELECT verified.label
               FROM verified_entity_addresses verified
               WHERE verified.address = event.venue
                 AND verified.retrieved_at <= event.event_time
                 AND verified.valid_from <= event.event_time
                 AND (verified.valid_to IS NULL OR verified.valid_to >= event.event_time)
               ORDER BY verified.valid_from DESC LIMIT 1
             ) venue ON true
             LEFT JOIN LATERAL (
               SELECT verified.label, verified.entity_type
               FROM entity_addresses address
               JOIN verified_entity_addresses verified ON verified.address = address.address
               WHERE address.entity_id = event.from_entity_id
                 AND verified.retrieved_at <= event.event_time
                 AND verified.valid_from <= event.event_time
                 AND (verified.valid_to IS NULL OR verified.valid_to >= event.event_time)
               ORDER BY verified.valid_from DESC LIMIT 1
             ) from_attribution ON true
             LEFT JOIN LATERAL (
               SELECT verified.label, verified.entity_type
               FROM entity_addresses address
               JOIN verified_entity_addresses verified ON verified.address = address.address
               WHERE address.entity_id = event.to_entity_id
                 AND verified.retrieved_at <= event.event_time
                 AND verified.valid_from <= event.event_time
                 AND (verified.valid_to IS NULL OR verified.valid_to >= event.event_time)
               ORDER BY verified.valid_from DESC LIMIT 1
             ) to_attribution ON true
             LEFT JOIN LATERAL (
               SELECT jsonb_agg(jsonb_build_object(
                 'horizon', outcome.horizon,
                 'returnPct', outcome.return_pct::text
               ) ORDER BY outcome.exit_at, outcome.horizon) AS values
               FROM capital_event_forward_outcomes outcome
               WHERE outcome.event_id = event.event_id
             ) outcomes ON true
             LEFT JOIN LATERAL (
               SELECT count(*) AS prior_transfer_count,
                      avg(history.quantity) AS prior_quantity_mean,
                      stddev_samp(history.quantity) AS prior_quantity_stddev,
                      max(history.event_time) AS previous_event_time
               FROM (
                 SELECT prior.quantity, prior.event_time
                 FROM capital_events prior
                 WHERE prior.from_entity_id = event.from_entity_id
                   AND prior.event_time < event.event_time
                 ORDER BY prior.event_time DESC
                 LIMIT 200
               ) history
             ) wallet_history ON event.from_entity_id IS NOT NULL
             WHERE link.signature IN (SELECT jsonb_array_elements_text($1::jsonb))
             ORDER BY event.event_time DESC, event.event_id`,
            [JSON.stringify(signatures)],
          );
    const eventIds = linked.rows.map((row) => row.event_id);
    const reactionRows =
      eventIds.length === 0
        ? []
        : (
            await this.#database.query<{
              capital_event_id: string;
              window_seconds: string | number;
              venue: string;
              instrument_id: string;
              features: unknown;
            }>(
              `SELECT capital_event_id, window_seconds, venue, instrument_id, features
               FROM capital_event_market_reactions
               WHERE capital_event_id IN (SELECT jsonb_array_elements_text($1::jsonb))
               ORDER BY capital_event_id, window_seconds, venue`,
              [JSON.stringify(eventIds)],
            )
          ).rows;
    const reactionFeatureSchema = z.object({
      featureVersion: z.literal("1"),
      spreadBpsBefore: z.string().nullable(),
      spreadBpsAfter: z.string().nullable(),
      bidDepthBefore: z.string(),
      askDepthBefore: z.string(),
      bidDepthAfter: z.string(),
      askDepthAfter: z.string(),
      totalDepthChangePct: z.string().nullable(),
      aggressiveBuyVolume: z.string(),
      aggressiveSellVolume: z.string(),
      aggressorImbalance: z.string().nullable(),
      tradedVolume: z.string(),
      realizedVolatilityPct: z.string().nullable(),
      midPriceReturnPct: z.string().nullable(),
      absorptionScore: z.string().nullable(),
      inputEventIds: z.array(z.string()),
    });
    const reactionsByEvent = new Map<
      string,
      FilteredCapitalAlert["capitalEvents"][number]["marketReactions"]
    >();
    for (const reaction of reactionRows) {
      const existing = reactionsByEvent.get(reaction.capital_event_id) ?? [];
      reactionsByEvent.set(reaction.capital_event_id, [
        ...existing,
        {
          windowSeconds: Number(reaction.window_seconds),
          venue: reaction.venue,
          instrumentId: reaction.instrument_id,
          features: reactionFeatureSchema.parse(reaction.features),
        },
      ]);
    }
    const eventsBySignature = new Map<string, FilteredCapitalAlert["capitalEvents"]>();
    for (const event of linked.rows) {
      const outcomes = z
        .array(z.object({ horizon: z.string(), returnPct: z.string() }))
        .parse(event.outcomes);
      const marketReactions = reactionsByEvent.get(event.event_id) ?? [];
      const priorTransferCount = Number(event.prior_transfer_count);
      const priorMean =
        event.prior_quantity_mean === null ? undefined : Number(event.prior_quantity_mean);
      const priorStddev =
        event.prior_quantity_stddev === null ? undefined : Number(event.prior_quantity_stddev);
      const quantity = Number(event.quantity);
      const quantityZScore =
        priorMean === undefined ||
        priorStddev === undefined ||
        !Number.isFinite(priorStddev) ||
        priorStddev <= 0
          ? undefined
          : (quantity - priorMean) / priorStddev;
      const dormantDays =
        event.previous_event_time === null
          ? undefined
          : Math.max(
              0,
              (new Date(event.event_time).getTime() -
                new Date(event.previous_event_time).getTime()) /
                86_400_000,
            );
      const intelligence = classifyAlertIntelligence({
        ...(event.from_entity_type === null ? {} : { fromEntityType: event.from_entity_type }),
        ...(event.to_entity_type === null ? {} : { toEntityType: event.to_entity_type }),
        ...(event.from_label === null ? {} : { fromLabel: event.from_label }),
        ...(event.to_label === null ? {} : { toLabel: event.to_label }),
        ...(event.venue_label === null ? {} : { venueLabel: event.venue_label }),
        priorTransferCount,
        ...(quantityZScore === undefined ? {} : { quantityZScore }),
        ...(dormantDays === undefined ? {} : { dormantDays }),
        finalized: true,
        normalized: true,
        outcomeCount: outcomes.length,
      });
      const existing = eventsBySignature.get(event.signature) ?? [];
      eventsBySignature.set(event.signature, [
        ...existing,
        {
          eventId: event.event_id,
          eventTime: toIsoTimestamp(event.event_time),
          quantity: new Decimal(event.quantity).toFixed(),
          assetId: event.asset_id,
          ...(event.venue_label === null ? {} : { venueLabel: event.venue_label }),
          ...(event.from_label === null ? {} : { fromLabel: event.from_label }),
          ...(event.from_entity_type === null ? {} : { fromEntityType: event.from_entity_type }),
          ...(event.to_label === null ? {} : { toLabel: event.to_label }),
          ...(event.to_entity_type === null ? {} : { toEntityType: event.to_entity_type }),
          outcomes,
          marketReactions,
          walletHistory: {
            priorTransferCount,
            ...(quantityZScore === undefined ? {} : { quantityZScore }),
            ...(dormantDays === undefined ? {} : { dormantDays }),
          },
          intelligence,
        },
      ]);
    }
    return base.rows.map((row) => {
      const capitalEvents = eventsBySignature.get(row.signature) ?? [];
      return {
        providerId: row.provider_id,
        filterId: row.filter_id,
        signature: row.signature,
        slot: String(row.slot),
        receivedAt: toIsoTimestamp(row.received_at),
        reconciliationStatus: row.reconciliation_status ?? "PENDING",
        ...(row.normalized_at === null ? {} : { normalizedAt: toIsoTimestamp(row.normalized_at) }),
        summary: summarizeAlertIntelligence(
          capitalEvents.map((event) => ({
            assetId: event.assetId,
            intelligence: event.intelligence,
            outcomeCount: event.outcomes.length,
            marketReactionCount: event.marketReactions.length,
            ...(event.walletHistory.quantityZScore === undefined
              ? {}
              : { quantityZScore: event.walletHistory.quantityZScore }),
          })),
        ),
        capitalEvents,
      };
    });
  }

  public async upsertFilteredStreamCheckpoint(candidate: FilteredStreamCheckpoint): Promise<void> {
    if (
      candidate.highestReceivedSlot !== undefined &&
      !/^(0|[1-9][0-9]*)$/.test(candidate.highestReceivedSlot)
    )
      throw new Error("highest received slot is invalid");
    if (
      candidate.highestReconciledSlot !== undefined &&
      !/^(0|[1-9][0-9]*)$/.test(candidate.highestReconciledSlot)
    )
      throw new Error("highest reconciled slot is invalid");
    await this.#database.query(
      `INSERT INTO filtered_stream_checkpoints
        (provider_id, filter_id, highest_received_slot, highest_reconciled_slot, reconnect_count,
         last_connected_at, last_disconnected_at, last_error, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (provider_id, filter_id) DO UPDATE SET
         highest_received_slot = EXCLUDED.highest_received_slot,
         highest_reconciled_slot = EXCLUDED.highest_reconciled_slot,
         reconnect_count = EXCLUDED.reconnect_count,
         last_connected_at = EXCLUDED.last_connected_at,
         last_disconnected_at = EXCLUDED.last_disconnected_at,
         last_error = EXCLUDED.last_error,
         updated_at = EXCLUDED.updated_at
       WHERE filtered_stream_checkpoints.updated_at <= EXCLUDED.updated_at`,
      [
        candidate.providerId,
        candidate.filterId,
        candidate.highestReceivedSlot ?? null,
        candidate.highestReconciledSlot ?? null,
        candidate.reconnectCount,
        candidate.lastConnectedAt ?? null,
        candidate.lastDisconnectedAt ?? null,
        candidate.lastError ?? null,
        candidate.updatedAt,
      ],
    );
  }

  public async persistResearchProtocol(candidate: ResearchProtocol): Promise<boolean> {
    const protocol = ResearchProtocolSchema.parse(candidate);
    const result = await this.#database.query(
      `INSERT INTO research_protocols
        (protocol_id, name, version, objective, dataset_cutoff, frozen_at, protocol,
         code_hash, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
       ON CONFLICT (protocol_id) DO NOTHING`,
      [
        protocol.protocolId,
        protocol.name,
        Number(protocol.version),
        protocol.objective,
        protocol.datasetCutoff,
        protocol.frozenAt,
        JSON.stringify(protocol),
        protocol.codeHash,
        protocol.contentHash,
      ],
    );
    const inserted = (result.affectedRows ?? 0) > 0;
    if (!inserted) {
      const existing = await this.#database.query<{ content_hash: string }>(
        "SELECT content_hash FROM research_protocols WHERE protocol_id = $1",
        [protocol.protocolId],
      );
      if (existing.rows[0]?.content_hash !== protocol.contentHash)
        throw new Error(`research protocol identity collision: ${protocol.protocolId}`);
    }
    return inserted;
  }

  public async researchProtocol(protocolId: string): Promise<ResearchProtocol | undefined> {
    const result = await this.#database.query<{ protocol: unknown }>(
      "SELECT protocol FROM research_protocols WHERE protocol_id = $1",
      [protocolId],
    );
    const row = result.rows[0];
    return row ? ResearchProtocolSchema.parse(row.protocol) : undefined;
  }

  public async transferMagnitudeObservations(
    datasetCutoff: string,
  ): Promise<readonly TransferOutcomeObservation[]> {
    const nativeSolAssetId = deterministicDomainId("asset", "solana:native:SOL");
    const result = await this.#database.query<{
      event_id: string;
      event_time: Date | string;
      horizon: TransferOutcomeObservation["horizon"];
      quantity: string | number;
      return_pct: string | number;
      episode_id: string | null;
      regime: string | null;
    }>(
      `SELECT event.event_id, event.event_time, outcome.horizon,
              event.quantity::text, outcome.return_pct::text,
              episode.episode_id, regime.state AS regime
       FROM capital_events event
       INNER JOIN capital_event_forward_outcomes outcome ON outcome.event_id = event.event_id
       LEFT JOIN LATERAL (
         SELECT candidate.episode_id
         FROM capital_flow_episode_events link
         JOIN capital_flow_episodes candidate ON candidate.episode_id = link.episode_id
         WHERE link.event_id = event.event_id AND candidate.algorithm_version = 2
         ORDER BY candidate.episode_id LIMIT 1
       ) episode ON true
       LEFT JOIN LATERAL (
         SELECT snapshot.state FROM market_regime_snapshots snapshot
         WHERE snapshot.as_of <= event.event_time AND snapshot.state <> 'INSUFFICIENT_DATA'
         ORDER BY snapshot.as_of DESC, snapshot.regime_id DESC LIMIT 1
       ) regime ON true
       WHERE event.asset_id = $1 AND event.event_time <= $2
       ORDER BY outcome.horizon, event.event_time, event.event_id`,
      [nativeSolAssetId, datasetCutoff],
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      eventAt: toIsoTimestamp(row.event_time),
      horizon: row.horizon,
      quantity: Number(row.quantity),
      returnPct: Number(row.return_pct),
      ...(row.episode_id === null ? {} : { episodeId: row.episode_id }),
      ...(row.regime === null ? {} : { regime: row.regime }),
    }));
  }

  public async benchmarkAdjustedTransferMagnitudeObservations(
    datasetCutoff: string,
    benchmarkInstrumentId: string,
  ): Promise<readonly TransferOutcomeObservation[]> {
    const nativeSolAssetId = deterministicDomainId("asset", "solana:native:SOL");
    const result = await this.#database.query<{
      event_id: string;
      event_time: Date | string;
      horizon: TransferOutcomeObservation["horizon"];
      quantity: string | number;
      excess_return_pct: string | number;
      episode_id: string | null;
      regime: string | null;
    }>(
      `SELECT event.event_id, event.event_time, benchmark.horizon,
              event.quantity::text, benchmark.excess_return_pct::text,
              episode.episode_id, regime.state AS regime
       FROM capital_events event
       JOIN capital_event_benchmark_outcomes benchmark ON benchmark.event_id = event.event_id
       LEFT JOIN LATERAL (
         SELECT candidate.episode_id
         FROM capital_flow_episode_events link
         JOIN capital_flow_episodes candidate ON candidate.episode_id = link.episode_id
         WHERE link.event_id = event.event_id AND candidate.algorithm_version = 2
         ORDER BY candidate.episode_id LIMIT 1
       ) episode ON true
       LEFT JOIN LATERAL (
         SELECT snapshot.state FROM market_regime_snapshots snapshot
         WHERE snapshot.as_of <= event.event_time AND snapshot.state <> 'INSUFFICIENT_DATA'
         ORDER BY snapshot.as_of DESC, snapshot.regime_id DESC LIMIT 1
       ) regime ON true
       WHERE event.asset_id = $1 AND event.event_time <= $2
         AND benchmark.benchmark_instrument_id = $3 AND benchmark.labeling_version = 1
       ORDER BY benchmark.horizon, event.event_time, event.event_id`,
      [nativeSolAssetId, datasetCutoff, benchmarkInstrumentId],
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      eventAt: toIsoTimestamp(row.event_time),
      horizon: row.horizon,
      quantity: Number(row.quantity),
      returnPct: Number(row.excess_return_pct),
      ...(row.episode_id === null ? {} : { episodeId: row.episode_id }),
      ...(row.regime === null ? {} : { regime: row.regime }),
    }));
  }

  public async episodeBenchmarkAdjustedTransferMagnitudeObservations(
    datasetCutoff: string,
    benchmarkInstrumentId: string,
  ): Promise<readonly TransferOutcomeObservation[]> {
    const result = await this.#database.query<{
      episode_id: string;
      window_start: Date | string;
      horizon: TransferOutcomeObservation["horizon"];
      total_quantity: string | number;
      excess_return_pct: string | number;
      regime: string | null;
    }>(
      `SELECT episode.episode_id, episode.window_start, benchmark.horizon,
              episode.total_quantity::text, benchmark.excess_return_pct::text,
              regime.state AS regime
       FROM capital_flow_episodes episode
       JOIN capital_event_benchmark_outcomes benchmark
         ON benchmark.event_id = episode.anchor_event_id
       LEFT JOIN LATERAL (
         SELECT snapshot.state FROM market_regime_snapshots snapshot
         WHERE snapshot.as_of <= episode.window_start AND snapshot.state <> 'INSUFFICIENT_DATA'
         ORDER BY snapshot.as_of DESC, snapshot.regime_id DESC LIMIT 1
       ) regime ON true
       WHERE episode.window_start <= $1 AND episode.algorithm_version = 2
         AND benchmark.benchmark_instrument_id = $2 AND benchmark.labeling_version = 1
       ORDER BY benchmark.horizon, episode.window_start, episode.episode_id`,
      [datasetCutoff, benchmarkInstrumentId],
    );
    return result.rows.map((row) => ({
      eventId: row.episode_id,
      eventAt: toIsoTimestamp(row.window_start),
      horizon: row.horizon,
      quantity: Number(row.total_quantity),
      returnPct: Number(row.excess_return_pct),
      episodeId: row.episode_id,
      ...(row.regime === null ? {} : { regime: row.regime }),
    }));
  }

  public async categoricalFlowObservations(
    datasetCutoff: string,
  ): Promise<readonly CategoricalFlowObservation[]> {
    const nativeSolAssetId = deterministicDomainId("asset", "solana:native:SOL");
    const result = await this.#database.query<{
      event_id: string;
      event_time: Date | string;
      horizon: CategoricalFlowObservation["horizon"];
      cohort: string;
      return_pct: string | number;
      episode_id: string | null;
      regime: string | null;
    }>(
      `SELECT event.event_id, event.event_time, outcome.horizon,
              concat(COALESCE(from_attribution.entity_type, 'UNKNOWN'), '→',
                     COALESCE(to_attribution.entity_type, 'UNKNOWN'),
                     CASE WHEN venue_attribution.label IS NULL THEN ''
                          ELSE concat('|VIA:', venue_attribution.label) END) AS cohort,
              outcome.return_pct::text, episode.episode_id, regime.state AS regime
       FROM capital_events event
       JOIN capital_event_forward_outcomes outcome ON outcome.event_id = event.event_id
       LEFT JOIN LATERAL (
         SELECT candidate.episode_id
         FROM capital_flow_episode_events link
         JOIN capital_flow_episodes candidate ON candidate.episode_id = link.episode_id
         WHERE link.event_id = event.event_id AND candidate.algorithm_version = 2
         ORDER BY candidate.episode_id LIMIT 1
       ) episode ON true
       LEFT JOIN LATERAL (
         SELECT snapshot.state FROM market_regime_snapshots snapshot
         WHERE snapshot.as_of <= event.event_time AND snapshot.state <> 'INSUFFICIENT_DATA'
         ORDER BY snapshot.as_of DESC, snapshot.regime_id DESC LIMIT 1
       ) regime ON true
       LEFT JOIN LATERAL (
         SELECT verified.entity_type
         FROM entity_addresses address
         JOIN verified_entity_addresses verified ON verified.address = address.address
         WHERE address.entity_id = event.from_entity_id
           AND verified.retrieved_at <= event.event_time
           AND verified.valid_from <= event.event_time
           AND (verified.valid_to IS NULL OR verified.valid_to >= event.event_time)
         ORDER BY verified.valid_from DESC LIMIT 1
       ) from_attribution ON true
       LEFT JOIN LATERAL (
         SELECT verified.entity_type
         FROM entity_addresses address
         JOIN verified_entity_addresses verified ON verified.address = address.address
         WHERE address.entity_id = event.to_entity_id
           AND verified.retrieved_at <= event.event_time
           AND verified.valid_from <= event.event_time
           AND (verified.valid_to IS NULL OR verified.valid_to >= event.event_time)
         ORDER BY verified.valid_from DESC LIMIT 1
       ) to_attribution ON true
       LEFT JOIN LATERAL (
         SELECT verified.label
         FROM verified_entity_addresses verified
         WHERE verified.address = event.venue
           AND verified.retrieved_at <= event.event_time
           AND verified.valid_from <= event.event_time
           AND (verified.valid_to IS NULL OR verified.valid_to >= event.event_time)
         ORDER BY verified.valid_from DESC LIMIT 1
       ) venue_attribution ON true
       WHERE event.asset_id = $1 AND event.event_time <= $2
       ORDER BY outcome.horizon, event.event_time, event.event_id`,
      [nativeSolAssetId, datasetCutoff],
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      eventAt: toIsoTimestamp(row.event_time),
      horizon: row.horizon,
      cohort: row.cohort,
      returnPct: Number(row.return_pct),
      ...(row.episode_id === null ? {} : { episodeId: row.episode_id }),
      ...(row.regime === null ? {} : { regime: row.regime }),
    }));
  }

  public async marketReactionResearchObservations(
    datasetCutoff: string,
  ): Promise<readonly CategoricalFlowObservation[]> {
    const result = await this.#database.query<{
      event_id: string;
      event_time: Date | string;
      horizon: CategoricalFlowObservation["horizon"];
      cohort: string;
      return_pct: string | number;
      episode_id: string | null;
      regime: string | null;
    }>(
      `SELECT DISTINCT ON (outcome.horizon, event.event_time)
              event.event_id, event.event_time, outcome.horizon, outcome.return_pct::text,
              concat('REACTION_1M|', CASE
                WHEN abs(COALESCE((reaction.features->>'midPriceReturnPct')::numeric, 999)) <= 0.05
                 AND (reaction.features->>'aggressorImbalance')::numeric >= 0.5
                  THEN 'HEAVY_BUYING_LIMITED_UPSIDE'
                WHEN abs(COALESCE((reaction.features->>'midPriceReturnPct')::numeric, 999)) <= 0.05
                 AND (reaction.features->>'aggressorImbalance')::numeric <= -0.5
                  THEN 'HEAVY_SELLING_LIMITED_DOWNSIDE'
                WHEN COALESCE((reaction.features->>'totalDepthChangePct')::numeric, 0) <= -20
                  THEN 'LIQUIDITY_WITHDRAWAL'
                WHEN COALESCE((reaction.features->>'totalDepthChangePct')::numeric, 0) >= 20
                  THEN 'LIQUIDITY_ADDITION'
                WHEN COALESCE((reaction.features->>'spreadBpsBefore')::numeric, 0) > 0
                 AND COALESCE((reaction.features->>'spreadBpsAfter')::numeric, 0) >=
                     (reaction.features->>'spreadBpsBefore')::numeric * 1.5
                  THEN 'SPREAD_WIDENING'
                WHEN (reaction.features->>'aggressorImbalance')::numeric >= 0.5
                  THEN 'BUY_IMBALANCE'
                WHEN (reaction.features->>'aggressorImbalance')::numeric <= -0.5
                  THEN 'SELL_IMBALANCE'
                ELSE 'BALANCED_FLOW'
              END) AS cohort,
              episode.episode_id, regime.state AS regime
       FROM capital_event_market_reactions reaction
       JOIN capital_events event ON event.event_id = reaction.capital_event_id
       JOIN capital_event_forward_outcomes outcome
         ON outcome.event_id = event.event_id
        AND outcome.horizon IN ('5m','15m','1h','6h','24h')
       LEFT JOIN LATERAL (
         SELECT candidate.episode_id
         FROM capital_flow_episode_events link
         JOIN capital_flow_episodes candidate ON candidate.episode_id = link.episode_id
         WHERE link.event_id = event.event_id AND candidate.algorithm_version = 2
         ORDER BY candidate.episode_id LIMIT 1
       ) episode ON true
       LEFT JOIN LATERAL (
         SELECT snapshot.state FROM market_regime_snapshots snapshot
         WHERE snapshot.as_of <= event.event_time AND snapshot.state <> 'INSUFFICIENT_DATA'
         ORDER BY snapshot.as_of DESC, snapshot.regime_id DESC LIMIT 1
       ) regime ON true
       WHERE event.event_time <= $1 AND reaction.window_seconds = 60
       ORDER BY outcome.horizon, event.event_time, event.event_id`,
      [datasetCutoff],
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      eventAt: toIsoTimestamp(row.event_time),
      horizon: row.horizon,
      cohort: row.cohort,
      returnPct: Number(row.return_pct),
      ...(row.episode_id === null ? {} : { episodeId: row.episode_id }),
      ...(row.regime === null ? {} : { regime: row.regime }),
    }));
  }

  public async marketResponseFailureCoverage(datasetCutoff = new Date().toISOString()): Promise<{
    readonly featureCount: number;
    readonly completeFeatureCount: number;
    readonly cohorts: readonly { readonly label: string; readonly count: number }[];
  }> {
    const cutoff = toIsoTimestamp(datasetCutoff);
    const result = await this.#database.query<{
      label: string;
      count: string | number;
      complete_count: string | number;
    }>(
      `SELECT CASE
          WHEN abs((features->>'midPriceReturnPct')::numeric) <= 0.05
           AND (features->>'aggressorImbalance')::numeric >= 0.5
            THEN 'HEAVY_BUYING_LIMITED_UPSIDE'
          WHEN abs((features->>'midPriceReturnPct')::numeric) <= 0.05
           AND (features->>'aggressorImbalance')::numeric <= -0.5
            THEN 'HEAVY_SELLING_LIMITED_DOWNSIDE'
          WHEN (features->>'totalDepthChangePct')::numeric <= -20
            THEN 'LIQUIDITY_WITHDRAWAL'
          WHEN (features->>'totalDepthChangePct')::numeric >= 20
            THEN 'LIQUIDITY_ADDITION'
          WHEN (features->>'aggressorImbalance')::numeric >= 0.5 THEN 'BUY_IMBALANCE'
          WHEN (features->>'aggressorImbalance')::numeric <= -0.5 THEN 'SELL_IMBALANCE'
          ELSE 'BALANCED_FLOW'
        END AS label,
        count(*) AS count,
        count(*) FILTER (WHERE features->>'midPriceReturnPct' IS NOT NULL
          AND features->>'aggressorImbalance' IS NOT NULL
          AND features->>'totalDepthChangePct' IS NOT NULL) AS complete_count
       FROM capital_event_market_reactions
       WHERE window_seconds = 60 AND window_end <= $1
       GROUP BY label ORDER BY count(*) DESC, label`,
      [cutoff],
    );
    const cohorts = result.rows.map((row) => ({ label: row.label, count: Number(row.count) }));
    return {
      featureCount: cohorts.reduce((sum, cohort) => sum + cohort.count, 0),
      completeFeatureCount: result.rows.reduce((sum, row) => sum + Number(row.complete_count), 0),
      cohorts,
    };
  }

  public async walletBehaviorResearchObservations(
    datasetCutoff: string,
  ): Promise<readonly CategoricalFlowObservation[]> {
    const nativeSolAssetId = deterministicDomainId("asset", "solana:native:SOL");
    const result = await this.#database.query<{
      event_id: string;
      event_time: Date | string;
      horizon: CategoricalFlowObservation["horizon"];
      cohort: string;
      return_pct: string | number;
      episode_id: string | null;
      regime: string | null;
    }>(
      `WITH history AS (
         SELECT event.event_id, event.event_time, event.from_entity_id, event.quantity,
                count(*) OVER entity_history AS history_count,
                avg(event.quantity) OVER entity_history AS prior_mean,
                stddev_samp(event.quantity) OVER entity_history AS prior_stddev,
                lag(event.event_time) OVER (
                  PARTITION BY event.from_entity_id ORDER BY event.event_time, event.event_id
                ) AS previous_event_time
         FROM capital_events event
         WHERE event.asset_id = $1 AND event.event_time <= $2
         WINDOW entity_history AS (
           PARTITION BY event.from_entity_id ORDER BY event.event_time, event.event_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         )
       )
       SELECT history.event_id, history.event_time, outcome.horizon, outcome.return_pct::text,
              CASE
                WHEN history.history_count < 30 THEN 'INSUFFICIENT_WALLET_HISTORY'
                WHEN history.prior_stddev > 0
                 AND (history.quantity - history.prior_mean) / history.prior_stddev >= 3
                  THEN 'WALLET_SIZE_ANOMALY_Z_GE_3'
                WHEN history.previous_event_time IS NOT NULL
                 AND history.event_time - history.previous_event_time >= interval '7 days'
                  THEN 'WALLET_DORMANT_GE_7D'
                ELSE 'WALLET_NORMAL'
              END AS cohort,
              episode.episode_id, regime.state AS regime
       FROM history
       JOIN capital_event_forward_outcomes outcome ON outcome.event_id = history.event_id
       LEFT JOIN LATERAL (
         SELECT candidate.episode_id
         FROM capital_flow_episode_events link
         JOIN capital_flow_episodes candidate ON candidate.episode_id = link.episode_id
         WHERE link.event_id = history.event_id AND candidate.algorithm_version = 2
         ORDER BY candidate.episode_id LIMIT 1
       ) episode ON true
       LEFT JOIN LATERAL (
         SELECT snapshot.state FROM market_regime_snapshots snapshot
         WHERE snapshot.as_of <= history.event_time AND snapshot.state <> 'INSUFFICIENT_DATA'
         ORDER BY snapshot.as_of DESC, snapshot.regime_id DESC LIMIT 1
       ) regime ON true
       ORDER BY outcome.horizon, history.event_time, history.event_id`,
      [nativeSolAssetId, datasetCutoff],
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      eventAt: toIsoTimestamp(row.event_time),
      horizon: row.horizon,
      cohort: row.cohort,
      returnPct: Number(row.return_pct),
      ...(row.episode_id === null ? {} : { episodeId: row.episode_id }),
      ...(row.regime === null ? {} : { regime: row.regime }),
    }));
  }

  public async conditionalFlowReactionObservations(
    datasetCutoff: string,
  ): Promise<readonly CategoricalFlowObservation[]> {
    const reactions = await this.marketReactionResearchObservations(datasetCutoff);
    if (reactions.length === 0) return [];
    const direction = await this.categoricalFlowObservations(datasetCutoff);
    const directionByIdentity = new Map(
      direction.map((observation) => [
        `${observation.eventId}:${observation.horizon}`,
        observation.cohort,
      ]),
    );
    return reactions.map((observation) => ({
      ...observation,
      cohort: `${directionByIdentity.get(`${observation.eventId}:${observation.horizon}`) ?? "UNKNOWN→UNKNOWN"}|${observation.cohort}`,
    }));
  }

  public async walletBehaviorFeature(
    eventId: string,
    entityId: string,
    minimumHistory = 30,
    maximumHistory = 10_000,
  ): Promise<WalletBehaviorFeature> {
    if (
      !Number.isInteger(maximumHistory) ||
      maximumHistory < minimumHistory ||
      maximumHistory > 100_000
    )
      throw new Error("maximumHistory must be between minimumHistory and 100000");
    const event = await this.capitalEvent(eventId);
    if (!event) throw new Error(`capital event not found: ${eventId}`);
    if (event.fromEntityId !== entityId && event.toEntityId !== entityId)
      throw new Error("capital event does not touch the requested entity");
    const result = await this.#database.query<{
      event_id: string;
      event_time: Date | string;
      quantity: string | number;
      from_entity_id: string | null;
      to_entity_id: string | null;
    }>(
      `SELECT event_id, event_time, quantity::text, from_entity_id, to_entity_id
       FROM capital_events
       WHERE event_time < $1 AND (from_entity_id = $2 OR to_entity_id = $2)
       ORDER BY event_time DESC, event_id DESC LIMIT $3`,
      [event.eventTime, entityId, maximumHistory + 1],
    );
    if (result.rows.length > maximumHistory)
      throw new Error("wallet history exceeds the bounded point-in-time analysis limit");
    const priorEvents: WalletBehaviorEvent[] = result.rows.map((row) => ({
      eventId: row.event_id,
      eventTime: toIsoTimestamp(row.event_time),
      quantity: new Decimal(row.quantity).toString(),
      ...(row.from_entity_id === null ? {} : { fromEntityId: row.from_entity_id }),
      ...(row.to_entity_id === null ? {} : { toEntityId: row.to_entity_id }),
    }));
    return computeWalletBehaviorFeature({ event, entityId, priorEvents, minimumHistory });
  }

  public async walletBehaviorFeatureV2(
    eventId: string,
    entityId: string,
    minimumHistory = 30,
    maximumHistory = 10_000,
  ): Promise<WalletBehaviorFeatureV2> {
    if (
      !Number.isInteger(maximumHistory) ||
      maximumHistory < minimumHistory ||
      maximumHistory > 100_000
    )
      throw new Error("maximumHistory must be between minimumHistory and 100000");
    const event = await this.capitalEvent(eventId);
    if (!event) throw new Error(`capital event not found: ${eventId}`);
    if (event.fromEntityId !== entityId && event.toEntityId !== entityId)
      throw new Error("capital event does not touch the requested entity");
    const result = await this.#database.query<{
      event_id: string;
      event_time: Date | string;
      quantity: string | number;
      from_entity_id: string | null;
      to_entity_id: string | null;
    }>(
      `SELECT event_id, event_time, quantity::text, from_entity_id, to_entity_id
       FROM capital_events
       WHERE event_time < $1 AND (from_entity_id = $2 OR to_entity_id = $2)
       ORDER BY event_time DESC, event_id DESC LIMIT $3`,
      [event.eventTime, entityId, maximumHistory + 1],
    );
    if (result.rows.length > maximumHistory)
      throw new Error("wallet history exceeds the bounded point-in-time analysis limit");
    const priorEvents: WalletBehaviorEvent[] = result.rows.map((row) => ({
      eventId: row.event_id,
      eventTime: toIsoTimestamp(row.event_time),
      quantity: new Decimal(row.quantity).toString(),
      ...(row.from_entity_id === null ? {} : { fromEntityId: row.from_entity_id }),
      ...(row.to_entity_id === null ? {} : { toEntityId: row.to_entity_id }),
    }));
    return computeWalletBehaviorFeatureV2({ event, entityId, priorEvents, minimumHistory });
  }

  public async walletBehaviorCoverageReport(
    observedAt = new Date().toISOString(),
    minimumHistory = 30,
  ): Promise<{
    readonly observedAt: string;
    readonly minimumHistory: number;
    readonly rollupRunId?: string;
    readonly datasetCutoff?: string;
    readonly entityCount: number;
    readonly entitiesWith10Events: number;
    readonly entitiesWith30Events: number;
    readonly entitiesWith100Events: number;
    readonly eligibleEntityCount: number;
    readonly eligibleEntityPct: number;
    readonly endpointObservationCount: number;
    readonly eligibleFeatureObservationCount: number;
    readonly eligibleFeatureObservationPct: number;
    readonly bidirectionalEligibleEntityCount: number;
    readonly multiCounterpartyEligibleEntityCount: number;
  }> {
    if (!Number.isInteger(minimumHistory) || minimumHistory < 10 || minimumHistory > 10_000)
      throw new Error("minimumHistory must be between 10 and 10000");
    const cutoff = toIsoTimestamp(observedAt);
    const result = await this.#database.query<{
      run_id: string | null;
      dataset_cutoff: Date | string | null;
      entity_count: string | number;
      entities_10: string | number;
      entities_30: string | number;
      entities_100: string | number;
      eligible_entities: string | number;
      endpoint_observations: string | number;
      eligible_observations: string | number;
      bidirectional_eligible: string | number;
      multi_counterparty_eligible: string | number;
    }>(
      `WITH latest_run AS (
         SELECT run_id, dataset_cutoff FROM entity_activity_rollup_runs
         WHERE dataset_cutoff <= $1
         ORDER BY dataset_cutoff DESC, generated_at DESC, run_id DESC LIMIT 1
       )
       SELECT run.run_id, run.dataset_cutoff,
              count(rollup.address) AS entity_count,
              count(*) FILTER (WHERE rollup.event_count >= 10) AS entities_10,
              count(*) FILTER (WHERE rollup.event_count >= 30) AS entities_30,
              count(*) FILTER (WHERE rollup.event_count >= 100) AS entities_100,
              count(*) FILTER (WHERE rollup.event_count >= $2) AS eligible_entities,
              coalesce(sum(rollup.event_count), 0) AS endpoint_observations,
              coalesce(sum(greatest(rollup.event_count - $2, 0)), 0) AS eligible_observations,
              count(*) FILTER (WHERE rollup.event_count >= $2
                AND rollup.inflow_event_count > 0 AND rollup.outflow_event_count > 0)
                AS bidirectional_eligible,
              count(*) FILTER (WHERE rollup.event_count >= $2
                AND rollup.unique_counterparty_count > 1) AS multi_counterparty_eligible
       FROM (SELECT 1) seed LEFT JOIN latest_run run ON true
       LEFT JOIN entity_activity_rollups rollup ON rollup.run_id = run.run_id
       GROUP BY run.run_id, run.dataset_cutoff`,
      [cutoff, minimumHistory],
    );
    const row = result.rows[0];
    if (!row) throw new Error("wallet behavior coverage query returned no row");
    const entityCount = Number(row.entity_count);
    const eligibleEntityCount = Number(row.eligible_entities);
    const endpointObservationCount = Number(row.endpoint_observations);
    const eligibleFeatureObservationCount = Number(row.eligible_observations);
    return {
      observedAt: cutoff,
      minimumHistory,
      ...(row.run_id === null ? {} : { rollupRunId: row.run_id }),
      ...(row.dataset_cutoff === null ? {} : { datasetCutoff: toIsoTimestamp(row.dataset_cutoff) }),
      entityCount,
      entitiesWith10Events: Number(row.entities_10),
      entitiesWith30Events: Number(row.entities_30),
      entitiesWith100Events: Number(row.entities_100),
      eligibleEntityCount,
      eligibleEntityPct: entityCount === 0 ? 0 : (eligibleEntityCount / entityCount) * 100,
      endpointObservationCount,
      eligibleFeatureObservationCount,
      eligibleFeatureObservationPct:
        endpointObservationCount === 0
          ? 0
          : (eligibleFeatureObservationCount / endpointObservationCount) * 100,
      bidirectionalEligibleEntityCount: Number(row.bidirectional_eligible),
      multiCounterpartyEligibleEntityCount: Number(row.multi_counterparty_eligible),
    };
  }

  public async entityVerificationCandidates(
    asOf: string,
    minimumEventCount = 100,
    limit = 100,
  ): Promise<readonly EntityVerificationCandidate[]> {
    if (!Number.isInteger(minimumEventCount) || minimumEventCount < 1)
      throw new Error("minimumEventCount must be a positive integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
      throw new Error("limit must be between 1 and 1000");
    const cutoff = toIsoTimestamp(asOf);
    const result = await this.#database.query<{
      address: string;
      event_count: string | number;
      unique_counterparty_count: string | number;
      inflow_event_count: string | number;
      outflow_event_count: string | number;
      first_seen_at: Date | string;
      last_seen_at: Date | string;
      verified_label: string | null;
      verified_entity_type: string | null;
      verified_source: string | null;
      verified_source_url: string | null;
    }>(
      `WITH selected_run AS (
         SELECT run_id FROM entity_activity_rollup_runs
         WHERE dataset_cutoff <= $1
         ORDER BY dataset_cutoff DESC, generated_at DESC, run_id DESC LIMIT 1
       ), ranked AS (
         SELECT rollup.address, rollup.event_count, rollup.unique_counterparty_count,
                rollup.inflow_event_count, rollup.outflow_event_count,
                rollup.first_seen_at, rollup.last_seen_at
         FROM entity_activity_rollups rollup JOIN selected_run USING (run_id)
         WHERE rollup.event_count >= $2
         ORDER BY rollup.event_count DESC, rollup.address LIMIT $3
       )
       SELECT ranked.address, ranked.event_count,
              ranked.unique_counterparty_count, ranked.inflow_event_count,
              ranked.outflow_event_count, ranked.first_seen_at, ranked.last_seen_at,
              verified.label AS verified_label, verified.entity_type AS verified_entity_type,
              verified.source AS verified_source, verified.source_url AS verified_source_url
       FROM ranked
       LEFT JOIN LATERAL (
         SELECT candidate.label, candidate.entity_type, candidate.source, candidate.source_url
         FROM verified_entity_addresses candidate
         WHERE candidate.address = ranked.address AND candidate.valid_from <= $1
           AND (candidate.valid_to IS NULL OR candidate.valid_to > $1)
           AND candidate.retrieved_at <= $1
         ORDER BY candidate.valid_from DESC, candidate.retrieved_at DESC LIMIT 1
       ) verified ON true
       ORDER BY ranked.event_count DESC, ranked.address`,
      [cutoff, minimumEventCount, limit],
    );
    return result.rows.map((row, index) => {
      const activity = {
        eventCount: Number(row.event_count),
        uniqueCounterpartyCount: Number(row.unique_counterparty_count),
        inflowEventCount: Number(row.inflow_event_count),
        outflowEventCount: Number(row.outflow_event_count),
      };
      const verifiedIdentity =
        row.verified_label === null ||
        row.verified_entity_type === null ||
        row.verified_source === null ||
        row.verified_source_url === null
          ? undefined
          : {
              label: row.verified_label,
              entityType: row.verified_entity_type,
              source: row.verified_source,
              sourceUrl: row.verified_source_url,
            };
      return {
        rank: index + 1,
        entityId: deterministicDomainId("entity", `solana:address:${row.address}`),
        address: row.address,
        ...activity,
        firstSeenAt: toIsoTimestamp(row.first_seen_at),
        lastSeenAt: toIsoTimestamp(row.last_seen_at),
        behaviorHeuristic: classifyEntityBehavior(activity),
        identityStatus:
          verifiedIdentity === undefined ? ("UNKNOWN" as const) : ("VERIFIED" as const),
        ...(verifiedIdentity === undefined ? {} : { verifiedIdentity }),
      };
    });
  }

  public async entityAttributionQualityReport(
    observedAt = new Date().toISOString(),
  ): Promise<EntityAttributionQualityReport> {
    const asOf = toIsoTimestamp(observedAt);
    const result = await this.#database.query<{
      archived_block_count: string | number;
      extracted_block_count: string | number;
      corrected_endpoint_count: string | number;
      distinct_token_account_count: string | number;
      distinct_owner_count: string | number;
      run_id: string | null;
      dataset_cutoff: Date | string | null;
      rolled_up_address_count: string | number;
      rolled_up_endpoint_count: string | number;
      verified_address_count: string | number;
      verified_endpoint_count: string | number;
    }>(
      `WITH latest_run AS (
         SELECT run_id, dataset_cutoff FROM entity_activity_rollup_runs
         WHERE dataset_cutoff <= $1
         ORDER BY dataset_cutoff DESC, generated_at DESC, run_id DESC LIMIT 1
       ), rollup_quality AS (
         SELECT count(*) AS rolled_up_address_count,
                coalesce(sum(rollup.event_count), 0) AS rolled_up_endpoint_count,
                count(*) FILTER (WHERE verified.address IS NOT NULL) AS verified_address_count,
                coalesce(sum(rollup.event_count) FILTER (WHERE verified.address IS NOT NULL), 0)
                  AS verified_endpoint_count
         FROM entity_activity_rollups rollup JOIN latest_run run USING (run_id)
         LEFT JOIN LATERAL (
           SELECT candidate.address FROM verified_entity_addresses candidate
           WHERE candidate.address = rollup.address AND candidate.valid_from <= run.dataset_cutoff
             AND (candidate.valid_to IS NULL OR candidate.valid_to > run.dataset_cutoff)
             AND candidate.retrieved_at <= run.dataset_cutoff
           ORDER BY candidate.valid_from DESC LIMIT 1
         ) verified ON true
       )
       SELECT
         (SELECT count(*) FROM raw_chain_blocks WHERE chain = 'solana') AS archived_block_count,
         (SELECT count(*) FROM solana_owner_extractions) AS extracted_block_count,
         (SELECT count(*) FROM capital_event_owner_corrections) AS corrected_endpoint_count,
         (SELECT count(DISTINCT token_account_address)
            FROM solana_token_account_owner_observations) AS distinct_token_account_count,
         (SELECT count(DISTINCT owner_address)
            FROM solana_token_account_owner_observations) AS distinct_owner_count,
         run.run_id, run.dataset_cutoff, quality.rolled_up_address_count,
         quality.rolled_up_endpoint_count, quality.verified_address_count,
         quality.verified_endpoint_count
       FROM (SELECT 1) seed LEFT JOIN latest_run run ON true
       LEFT JOIN rollup_quality quality ON true`,
      [asOf],
    );
    const row = result.rows[0];
    if (!row) throw new Error("entity attribution quality query returned no row");
    const archivedBlockCount = Number(row.archived_block_count);
    const extractedBlockCount = Number(row.extracted_block_count);
    const rolledUpEndpointCount = Number(row.rolled_up_endpoint_count);
    const verifiedRolledUpEndpointCount = Number(row.verified_endpoint_count);
    return {
      observedAt: asOf,
      archivedBlockCount,
      extractedBlockCount,
      extractionCoveragePct:
        archivedBlockCount === 0 ? 0 : (extractedBlockCount / archivedBlockCount) * 100,
      correctedEndpointCount: Number(row.corrected_endpoint_count),
      distinctTokenAccountCount: Number(row.distinct_token_account_count),
      distinctOwnerCount: Number(row.distinct_owner_count),
      ...(row.run_id === null ? {} : { rollupRunId: row.run_id }),
      ...(row.dataset_cutoff === null
        ? {}
        : { rollupDatasetCutoff: toIsoTimestamp(row.dataset_cutoff) }),
      rolledUpAddressCount: Number(row.rolled_up_address_count),
      rolledUpEndpointCount,
      verifiedRolledUpAddressCount: Number(row.verified_address_count),
      verifiedRolledUpEndpointCount,
      verifiedEndpointCoveragePct:
        rolledUpEndpointCount === 0
          ? 0
          : (verifiedRolledUpEndpointCount / rolledUpEndpointCount) * 100,
    };
  }

  public async materializePumpSwapFlowWindows(
    datasetCutoff: string,
    generatedAt = new Date().toISOString(),
  ): Promise<ProtocolFlowMaterializationResult> {
    const cutoff = toIsoTimestamp(datasetCutoff);
    const generated = toIsoTimestamp(generatedAt);
    const nativeSolAssetId = deterministicDomainId("asset", "solana:native:SOL");
    const wrappedSolAssetId = deterministicDomainId(
      "asset",
      "solana:spl:So11111111111111111111111111111111111111112",
    );
    const result = await this.#database.query<{
      window_start: Date | string;
      anchor_event_id: string;
      event_count: string | number;
      distinct_counterparty_count: string | number;
      native_sol_quantity: string | number;
      wrapped_sol_quantity: string | number;
      evidence_event_ids: unknown;
    }>(
      `WITH resolved AS (
         SELECT event.event_id, event.event_time, event.asset_id, event.quantity,
                coalesce(from_owner.owner_address, from_address.address) AS from_address,
                coalesce(to_owner.owner_address, to_address.address) AS to_address,
                date_trunc('hour', event.event_time) +
                  floor(extract(minute FROM event.event_time) / 5) * interval '5 minutes'
                  AS window_start
         FROM capital_events event
         LEFT JOIN entity_addresses from_address ON from_address.entity_id = event.from_entity_id
         LEFT JOIN entity_addresses to_address ON to_address.entity_id = event.to_entity_id
         LEFT JOIN capital_event_owner_corrections from_owner
           ON from_owner.event_id = event.event_id AND from_owner.endpoint_side = 'FROM'
         LEFT JOIN capital_event_owner_corrections to_owner
           ON to_owner.event_id = event.event_id AND to_owner.endpoint_side = 'TO'
         WHERE event.event_time <= $1 AND event.asset_id IN ($2,$3)
       )
       SELECT flow.window_start,
              (array_agg(flow.event_id ORDER BY flow.event_time, flow.event_id))[1]
                AS anchor_event_id,
              count(*) AS event_count,
              count(DISTINCT flow.from_address) AS distinct_counterparty_count,
              coalesce(sum(flow.quantity) FILTER (WHERE flow.asset_id = $2), 0)::text
                AS native_sol_quantity,
              coalesce(sum(flow.quantity) FILTER (WHERE flow.asset_id = $3), 0)::text
                AS wrapped_sol_quantity,
              to_jsonb((array_agg(flow.event_id ORDER BY flow.event_time, flow.event_id))[1:100])
                AS evidence_event_ids
       FROM resolved flow
       JOIN verified_entity_addresses verified ON verified.address = flow.to_address
       WHERE verified.source = 'pump-official-pumpswap-fee-recipients'
         AND verified.retrieved_at <= flow.event_time AND verified.valid_from <= flow.event_time
         AND (verified.valid_to IS NULL OR verified.valid_to >= flow.event_time)
         AND flow.window_start + interval '5 minutes' <= $1
       GROUP BY flow.window_start ORDER BY flow.window_start`,
      [cutoff, nativeSolAssetId, wrappedSolAssetId],
    );
    let insertedWindowCount = 0;
    const priorCounts: number[] = [];
    for (const row of result.rows) {
      const eventCount = Number(row.event_count);
      const baseline = priorCounts.slice(-12);
      const priorMean =
        baseline.length === 0
          ? undefined
          : baseline.reduce((sum, value) => sum + value, 0) / baseline.length;
      const priorStddev =
        baseline.length < 2 || priorMean === undefined
          ? undefined
          : Math.sqrt(
              baseline.reduce((sum, value) => sum + (value - priorMean) ** 2, 0) /
                (baseline.length - 1),
            );
      const eventCountZScore =
        priorStddev === undefined || priorStddev === 0 || priorMean === undefined
          ? undefined
          : (eventCount - priorMean) / priorStddev;
      const windowStart = toIsoTimestamp(row.window_start);
      const windowEnd = new Date(new Date(windowStart).getTime() + 300_000).toISOString();
      const featureId = deterministicDomainId("protocol_flow", `pumpswap:${windowStart}:1`);
      const identity = {
        featureId,
        protocolKey: "PUMPSWAP_FEE_RECIPIENTS",
        windowStart,
        windowEnd,
        anchorEventId: row.anchor_event_id,
        eventCount,
        distinctCounterpartyCount: Number(row.distinct_counterparty_count),
        nativeSolQuantity: new Decimal(row.native_sol_quantity).toString(),
        wrappedSolQuantity: new Decimal(row.wrapped_sol_quantity).toString(),
        priorWindowCount: baseline.length,
        ...(priorMean === undefined ? {} : { priorMeanEventCount: String(priorMean) }),
        ...(priorStddev === undefined ? {} : { priorStddevEventCount: String(priorStddev) }),
        ...(eventCountZScore === undefined ? {} : { eventCountZScore: String(eventCountZScore) }),
        evidenceEventIds: row.evidence_event_ids,
        generatedAt: generated,
        algorithmVersion: 1,
      };
      const insertion = await this.#database.query(
        `INSERT INTO protocol_flow_windows
          (feature_id, protocol_key, window_start, window_end, anchor_event_id, event_count,
           distinct_counterparty_count, native_sol_quantity, wrapped_sol_quantity,
           prior_window_count, prior_mean_event_count, prior_stddev_event_count,
           event_count_zscore, evidence_event_ids, generated_at, algorithm_version, record_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,1,$16)
         ON CONFLICT (protocol_key, window_start, algorithm_version) DO NOTHING`,
        [
          featureId,
          identity.protocolKey,
          windowStart,
          windowEnd,
          identity.anchorEventId,
          eventCount,
          identity.distinctCounterpartyCount,
          identity.nativeSolQuantity,
          identity.wrappedSolQuantity,
          baseline.length,
          priorMean ?? null,
          priorStddev ?? null,
          eventCountZScore ?? null,
          JSON.stringify(row.evidence_event_ids),
          generated,
          contentHash(identity),
        ],
      );
      insertedWindowCount += insertion.affectedRows ?? 0;
      priorCounts.push(eventCount);
    }
    const latestRow = result.rows.at(-1);
    return {
      eligibleWindowCount: result.rows.length,
      insertedWindowCount,
      ...(result.rows[0]
        ? { earliestWindowStart: toIsoTimestamp(result.rows[0].window_start) }
        : {}),
      ...(latestRow ? { latestWindowStart: toIsoTimestamp(latestRow.window_start) } : {}),
    };
  }

  public async pumpSwapFlowSummary(): Promise<ProtocolFlowSummary> {
    const result = await this.#database.query<{
      window_count: string | number;
      total_event_count: string | number;
      latest_window_start: Date | string | null;
      latest_event_count: string | number | null;
      latest_distinct_counterparty_count: string | number | null;
      latest_native_sol_quantity: string | number | null;
      latest_wrapped_sol_quantity: string | number | null;
      latest_event_count_zscore: string | number | null;
      mature_outcome_count: string | number;
      benchmark_outcome_count: string | number;
      mature_window_count: string | number;
      baseline_ready_window_count: string | number;
      analysis_ready_window_count: string | number;
    }>(
      `SELECT count(*) AS window_count, coalesce(sum(flow_window.event_count), 0) AS total_event_count,
              latest.window_start AS latest_window_start, latest.event_count AS latest_event_count,
              latest.distinct_counterparty_count AS latest_distinct_counterparty_count,
              latest.native_sol_quantity::text AS latest_native_sol_quantity,
              latest.wrapped_sol_quantity::text AS latest_wrapped_sol_quantity,
              latest.event_count_zscore::text AS latest_event_count_zscore,
              (SELECT count(*) FROM protocol_flow_windows flow
               JOIN protocol_flow_forward_outcomes outcome
                 ON outcome.feature_id = flow.feature_id
               WHERE flow.protocol_key = 'PUMPSWAP_FEE_RECIPIENTS') AS mature_outcome_count,
              (SELECT count(*) FROM protocol_flow_windows flow
               JOIN protocol_flow_benchmark_outcomes outcome
                 ON outcome.feature_id = flow.feature_id
               WHERE flow.protocol_key = 'PUMPSWAP_FEE_RECIPIENTS') AS benchmark_outcome_count,
              (SELECT count(DISTINCT flow.feature_id) FROM protocol_flow_windows flow
               JOIN protocol_flow_forward_outcomes outcome
                 ON outcome.feature_id = flow.feature_id
               WHERE flow.protocol_key = 'PUMPSWAP_FEE_RECIPIENTS') AS mature_window_count,
              (SELECT count(*) FROM protocol_flow_windows flow
               WHERE flow.protocol_key = 'PUMPSWAP_FEE_RECIPIENTS'
                 AND flow.prior_window_count >= 12
                 AND flow.event_count_zscore IS NOT NULL) AS baseline_ready_window_count,
              (SELECT count(DISTINCT flow.feature_id) FROM protocol_flow_windows flow
               JOIN protocol_flow_forward_outcomes outcome
                 ON outcome.feature_id = flow.feature_id
               JOIN protocol_flow_benchmark_outcomes benchmark
                 ON benchmark.feature_id = outcome.feature_id
                AND benchmark.horizon = outcome.horizon
               WHERE flow.protocol_key = 'PUMPSWAP_FEE_RECIPIENTS'
                 AND flow.prior_window_count >= 12
                 AND flow.event_count_zscore IS NOT NULL) AS analysis_ready_window_count
       FROM protocol_flow_windows flow_window
       LEFT JOIN LATERAL (
         SELECT candidate.* FROM protocol_flow_windows candidate
         WHERE candidate.protocol_key = 'PUMPSWAP_FEE_RECIPIENTS'
         ORDER BY candidate.window_start DESC LIMIT 1
       ) latest ON true
       WHERE flow_window.protocol_key = 'PUMPSWAP_FEE_RECIPIENTS'
       GROUP BY latest.window_start, latest.event_count, latest.distinct_counterparty_count,
                latest.native_sol_quantity, latest.wrapped_sol_quantity,
                latest.event_count_zscore`,
    );
    const row = result.rows[0];
    return {
      protocolKey: "PUMPSWAP_FEE_RECIPIENTS",
      windowCount: Number(row?.window_count ?? 0),
      totalEventCount: Number(row?.total_event_count ?? 0),
      ...(row?.latest_window_start == null
        ? {}
        : { latestWindowStart: toIsoTimestamp(row.latest_window_start) }),
      ...(row?.latest_event_count == null
        ? {}
        : { latestEventCount: Number(row.latest_event_count) }),
      ...(row?.latest_distinct_counterparty_count == null
        ? {}
        : { latestDistinctCounterpartyCount: Number(row.latest_distinct_counterparty_count) }),
      ...(row?.latest_native_sol_quantity == null
        ? {}
        : { latestNativeSolQuantity: new Decimal(row.latest_native_sol_quantity).toString() }),
      ...(row?.latest_wrapped_sol_quantity == null
        ? {}
        : { latestWrappedSolQuantity: new Decimal(row.latest_wrapped_sol_quantity).toString() }),
      ...(row?.latest_event_count_zscore == null
        ? {}
        : { latestEventCountZScore: new Decimal(row.latest_event_count_zscore).toString() }),
      matureOutcomeCount: Number(row?.mature_outcome_count ?? 0),
      benchmarkOutcomeCount: Number(row?.benchmark_outcome_count ?? 0),
      matureWindowCount: Number(row?.mature_window_count ?? 0),
      baselineReadyWindowCount: Number(row?.baseline_ready_window_count ?? 0),
      analysisReadyWindowCount: Number(row?.analysis_ready_window_count ?? 0),
    };
  }

  public async pumpSwapProtocolReadiness(): Promise<PumpSwapProtocolReadiness> {
    const result = await this.#database.query<{
      protocol_id: string;
      frozen_at: Date | string;
      dataset_cutoff: Date | string;
      minimum_sample_size: string | number;
      holdout_fraction: string | number;
      holdout_access_count: string | number;
      generated_at: Date | string | null;
      status: "COMPLETE" | "INSUFFICIENT_DATA" | null;
      observation_count: string | number | null;
      randomized_timestamp_trials: string | number | null;
    }>(
      `SELECT protocol.protocol_id, protocol.frozen_at, protocol.dataset_cutoff,
              protocol.protocol->>'minimumSampleSize' AS minimum_sample_size,
              protocol.protocol->>'holdoutFraction' AS holdout_fraction,
              (SELECT count(*) FROM holdout_access_audit audit
               WHERE audit.protocol_id = protocol.protocol_id) AS holdout_access_count,
              latest.generated_at, latest.status, latest.observation_count,
              latest.result->>'randomizedTimestampTrials' AS randomized_timestamp_trials
       FROM research_protocols protocol
       LEFT JOIN LATERAL (
         SELECT run.generated_at, run.status, run.observation_count, run.result
         FROM research_analysis_runs run
         WHERE run.protocol_id = protocol.protocol_id AND run.analysis_family = 'PROTOCOL_FLOW'
         ORDER BY run.generated_at DESC, run.run_id DESC LIMIT 1
       ) latest ON true
       WHERE protocol.name = 'CFIE PumpSwap Protocol-Flow Research'
       ORDER BY protocol.version DESC LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row)
      return {
        registered: false,
        holdoutAccessCount: 0,
        holdoutSealed: true,
        latestObservationCount: 0,
        randomizedTimestampTrials: 0,
      };
    const holdoutAccessCount = Number(row.holdout_access_count);
    return {
      registered: true,
      protocolId: row.protocol_id,
      frozenAt: toIsoTimestamp(row.frozen_at),
      datasetCutoff: toIsoTimestamp(row.dataset_cutoff),
      minimumSampleSize: Number(row.minimum_sample_size),
      holdoutFraction: Number(row.holdout_fraction),
      holdoutAccessCount,
      holdoutSealed: holdoutAccessCount === 0,
      ...(row.generated_at === null ? {} : { latestRunAt: toIsoTimestamp(row.generated_at) }),
      ...(row.status === null ? {} : { latestRunStatus: row.status }),
      latestObservationCount: Number(row.observation_count ?? 0),
      randomizedTimestampTrials: Number(row.randomized_timestamp_trials ?? 0),
    };
  }

  public async labelPumpSwapFlowForwardOutcomes(
    asOf: string,
    maximumEntryAgeSeconds = 30,
    maximumExitDelaySeconds = 60,
    maximumWindows = 1_000,
  ): Promise<number> {
    if (!Number.isInteger(maximumEntryAgeSeconds) || maximumEntryAgeSeconds < 1)
      throw new Error("maximumEntryAgeSeconds must be a positive integer");
    if (!Number.isInteger(maximumExitDelaySeconds) || maximumExitDelaySeconds < 1)
      throw new Error("maximumExitDelaySeconds must be a positive integer");
    if (!Number.isInteger(maximumWindows) || maximumWindows < 1 || maximumWindows > 10_000)
      throw new Error("maximumWindows must be between 1 and 10000");
    const cutoff = toIsoTimestamp(asOf);
    const windows = await this.#database.query<{
      feature_id: string;
      window_end: Date | string;
    }>(
      `SELECT flow.feature_id, flow.window_end
       FROM protocol_flow_windows flow
       WHERE flow.protocol_key = 'PUMPSWAP_FEE_RECIPIENTS' AND flow.algorithm_version = 1
         AND flow.window_end <= $1
         AND EXISTS (
           SELECT 1
           FROM (VALUES ('1m',60),('5m',300),('15m',900),('1h',3600),('6h',21600),('24h',86400))
                horizon(name, seconds)
           WHERE flow.window_end + horizon.seconds * interval '1 second' <= $1
             AND NOT EXISTS (
               SELECT 1 FROM protocol_flow_forward_outcomes outcome
               WHERE outcome.feature_id = flow.feature_id AND outcome.horizon = horizon.name
                 AND outcome.labeling_version = 1
             )
         )
       ORDER BY flow.window_end DESC, flow.feature_id LIMIT $2`,
      [cutoff, maximumWindows],
    );
    if (windows.rows.length === 0) return 0;
    const earliestWindowEnd = Math.min(
      ...windows.rows.map((row) => new Date(toIsoTimestamp(row.window_end)).getTime()),
    );
    const asOfTimestamp = new Date(cutoff).getTime();
    const horizonDurations = [60_000, 300_000, 900_000, 3_600_000, 21_600_000, 86_400_000];
    const requiredTimestamps = [
      ...new Set(
        windows.rows.flatMap((row) => {
          const windowEnd = new Date(toIsoTimestamp(row.window_end)).getTime();
          return [windowEnd, ...horizonDurations.map((duration) => windowEnd + duration)].filter(
            (timestamp) => timestamp <= asOfTimestamp,
          );
        }),
      ),
    ].sort((left, right) => left - right);
    const existing = await this.#database.query<{ as_of: Date | string }>(
      `SELECT as_of FROM reference_price_snapshots
       WHERE base_asset = 'SOL' AND quote_asset = 'USD' AND status = 'PUBLISHED'
         AND as_of >= $1 AND as_of <= $2 ORDER BY as_of`,
      [new Date(earliestWindowEnd - maximumEntryAgeSeconds * 1000).toISOString(), cutoff],
    );
    const existingTimestamps = existing.rows.map((row) =>
      new Date(toIsoTimestamp(row.as_of)).getTime(),
    );
    const missingTimestamps = requiredTimestamps
      .filter(
        (timestamp) =>
          !existingTimestamps.some(
            (candidate) =>
              candidate <= timestamp && candidate >= timestamp - maximumEntryAgeSeconds * 1000,
          ),
      )
      .slice(0, 100);
    for (const timestamp of missingTimestamps) {
      await this.computeAndPersistReferencePrice(
        [
          {
            venue: "coinbase-exchange",
            instrumentId: deterministicDomainId("instrument", "coinbase:SOL-USD"),
            baseAsset: "SOL",
            quoteAsset: "USD",
          },
          {
            venue: "binance-us-spot",
            instrumentId: deterministicDomainId("instrument", "binance-us-spot:SOLUSDT"),
            baseAsset: "SOL",
            quoteAsset: "USDT",
          },
        ],
        {
          venue: "coinbase-exchange",
          instrumentId: deterministicDomainId("instrument", "coinbase:USDT-USD"),
          baseAsset: "USDT",
          quoteAsset: "USD",
        },
        {
          baseAsset: "SOL",
          asOf: new Date(timestamp).toISOString(),
          minimumVenues: 2,
          maximumAgeMs: 30_000,
          maximumBasisAgeMs: 60_000,
          maximumDeviationBps: 100,
          maximumSpreadBps: 100,
        },
        { persistWithheld: false },
      );
    }
    const prices = await this.#database.query<{
      snapshot_id: string;
      as_of: Date | string;
      price: string;
    }>(
      `SELECT snapshot_id, as_of, price::text FROM reference_price_snapshots
       WHERE base_asset = 'SOL' AND quote_asset = 'USD' AND status = 'PUBLISHED'
         AND as_of >= $1 AND as_of <= $2 ORDER BY as_of, snapshot_id`,
      [new Date(earliestWindowEnd - maximumEntryAgeSeconds * 1000).toISOString(), cutoff],
    );
    const timeline = prices.rows.map((row) => ({
      snapshotId: row.snapshot_id,
      asOf: toIsoTimestamp(row.as_of),
      timestamp: new Date(toIsoTimestamp(row.as_of)).getTime(),
      price: new Decimal(row.price),
    }));
    const horizons = [
      ["1m", 60_000],
      ["5m", 300_000],
      ["15m", 900_000],
      ["1h", 3_600_000],
      ["6h", 21_600_000],
      ["24h", 86_400_000],
    ] as const;
    let labeled = 0;
    for (const flow of windows.rows) {
      const observationAt = toIsoTimestamp(flow.window_end);
      const observationTimestamp = new Date(observationAt).getTime();
      const entry = timeline.findLast(
        (candidate) =>
          candidate.timestamp <= observationTimestamp &&
          candidate.timestamp >= observationTimestamp - maximumEntryAgeSeconds * 1000,
      );
      if (!entry) continue;
      for (const [horizon, durationMs] of horizons) {
        const targetTimestamp = observationTimestamp + durationMs;
        if (targetTimestamp > asOfTimestamp) continue;
        const exit = timeline.find(
          (candidate) =>
            candidate.timestamp >= targetTimestamp &&
            candidate.timestamp <= targetTimestamp + maximumExitDelaySeconds * 1000,
        );
        if (!exit) continue;
        const path = timeline.filter(
          (candidate) =>
            candidate.timestamp >= entry.timestamp && candidate.timestamp <= exit.timestamp,
        );
        const returns = path.map((candidate) =>
          candidate.price.minus(entry.price).div(entry.price).mul(100),
        );
        const returnPct = exit.price.minus(entry.price).div(entry.price).mul(100);
        const identity = {
          featureId: flow.feature_id,
          horizon,
          entrySnapshotId: entry.snapshotId,
          exitSnapshotId: exit.snapshotId,
          observationAt,
          targetAt: new Date(targetTimestamp).toISOString(),
          exitAt: exit.asOf,
          entryPrice: entry.price.toString(),
          exitPrice: exit.price.toString(),
          returnPct: returnPct.toString(),
          maximumFavorableExcursionPct: Decimal.max(...returns).toString(),
          maximumAdverseExcursionPct: Decimal.min(...returns).toString(),
          entryAgeMs: observationTimestamp - entry.timestamp,
          labelingVersion: 1,
          labeledAt: cutoff,
        };
        const insertion = await this.#database.query(
          `INSERT INTO protocol_flow_forward_outcomes
            (feature_id, horizon, entry_snapshot_id, exit_snapshot_id, observation_at, target_at,
             exit_at, entry_price, exit_price, return_pct, maximum_favorable_excursion_pct,
             maximum_adverse_excursion_pct, entry_age_ms, labeling_version, labeled_at, content_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$15)
           ON CONFLICT (feature_id, horizon, labeling_version) DO NOTHING`,
          [
            identity.featureId,
            identity.horizon,
            identity.entrySnapshotId,
            identity.exitSnapshotId,
            identity.observationAt,
            identity.targetAt,
            identity.exitAt,
            identity.entryPrice,
            identity.exitPrice,
            identity.returnPct,
            identity.maximumFavorableExcursionPct,
            identity.maximumAdverseExcursionPct,
            identity.entryAgeMs,
            identity.labeledAt,
            contentHash(identity),
          ],
        );
        labeled += insertion.affectedRows ?? 0;
      }
    }
    return labeled;
  }

  public async labelPumpSwapFlowBenchmarkOutcomes(input: {
    readonly asOf: string;
    readonly venue?: string;
    readonly instrumentId?: string;
    readonly maximumEntryAgeSeconds?: number;
    readonly maximumExitDelaySeconds?: number;
    readonly maximumOutcomes?: number;
  }): Promise<number> {
    const venue = input.venue ?? "coinbase-exchange";
    const instrumentId =
      input.instrumentId ?? deterministicDomainId("instrument", "coinbase:BTC-USD");
    const maximumEntryAgeSeconds = input.maximumEntryAgeSeconds ?? 30;
    const maximumExitDelaySeconds = input.maximumExitDelaySeconds ?? 60;
    const maximumOutcomes = input.maximumOutcomes ?? 10_000;
    if (!Number.isInteger(maximumEntryAgeSeconds) || maximumEntryAgeSeconds < 1)
      throw new Error("maximum benchmark entry age must be positive");
    if (!Number.isInteger(maximumExitDelaySeconds) || maximumExitDelaySeconds < 1)
      throw new Error("maximum benchmark exit delay must be positive");
    if (!Number.isInteger(maximumOutcomes) || maximumOutcomes < 1 || maximumOutcomes > 100_000)
      throw new Error("maximum benchmark outcomes must be between 1 and 100000");
    const cutoff = toIsoTimestamp(input.asOf);
    const candidates = await this.#database.query<{
      feature_id: string;
      horizon: string;
      observation_at: Date | string;
      target_at: Date | string;
      sol_return_pct: string | number;
    }>(
      `SELECT outcome.feature_id, outcome.horizon, outcome.observation_at, outcome.target_at,
              outcome.return_pct::text AS sol_return_pct
       FROM protocol_flow_forward_outcomes outcome
       JOIN protocol_flow_windows flow ON flow.feature_id = outcome.feature_id
       WHERE flow.protocol_key = 'PUMPSWAP_FEE_RECIPIENTS'
         AND outcome.labeling_version = 1 AND outcome.target_at <= $1
         AND NOT EXISTS (
           SELECT 1 FROM protocol_flow_benchmark_outcomes benchmark
           WHERE benchmark.feature_id = outcome.feature_id
             AND benchmark.horizon = outcome.horizon
             AND benchmark.benchmark_instrument_id = $2
             AND benchmark.labeling_version = 1
         )
       ORDER BY outcome.observation_at, outcome.feature_id, outcome.horizon LIMIT $3`,
      [cutoff, instrumentId, maximumOutcomes],
    );
    if (candidates.rows.length === 0) return 0;
    const earliest = Math.min(
      ...candidates.rows.map((row) => new Date(toIsoTimestamp(row.observation_at)).getTime()),
    );
    const trades = await this.#database.query<{
      event_id: string;
      event_time: Date | string;
      price: string;
    }>(
      `SELECT event_id, event_time, price::text FROM canonical_market_events
       WHERE venue = $1 AND instrument_id = $2 AND event_type = 'TRADE' AND price IS NOT NULL
         AND event_time >= $3 AND event_time <= $4 ORDER BY event_time, event_id`,
      [
        venue,
        instrumentId,
        new Date(earliest - maximumEntryAgeSeconds * 1000).toISOString(),
        cutoff,
      ],
    );
    const timeline = trades.rows.map((row) => ({
      eventId: row.event_id,
      eventAt: toIsoTimestamp(row.event_time),
      timestamp: new Date(toIsoTimestamp(row.event_time)).getTime(),
      price: new Decimal(row.price),
    }));
    let labeled = 0;
    for (const candidate of candidates.rows) {
      const observationAt = toIsoTimestamp(candidate.observation_at);
      const targetAt = toIsoTimestamp(candidate.target_at);
      const observationTimestamp = new Date(observationAt).getTime();
      const targetTimestamp = new Date(targetAt).getTime();
      const entry = timeline.findLast(
        (trade) =>
          trade.timestamp <= observationTimestamp &&
          trade.timestamp >= observationTimestamp - maximumEntryAgeSeconds * 1000,
      );
      const exit = timeline.find(
        (trade) =>
          trade.timestamp >= targetTimestamp &&
          trade.timestamp <= targetTimestamp + maximumExitDelaySeconds * 1000,
      );
      if (!entry || !exit) continue;
      const benchmarkReturn = exit.price.minus(entry.price).div(entry.price).mul(100);
      const solReturn = new Decimal(candidate.sol_return_pct);
      const identity = {
        featureId: candidate.feature_id,
        horizon: candidate.horizon,
        benchmarkInstrumentId: instrumentId,
        entryEventId: entry.eventId,
        exitEventId: exit.eventId,
        observationAt,
        targetAt,
        exitAt: exit.eventAt,
        benchmarkEntryPrice: entry.price.toString(),
        benchmarkExitPrice: exit.price.toString(),
        benchmarkReturnPct: benchmarkReturn.toString(),
        solReturnPct: solReturn.toString(),
        excessReturnPct: solReturn.minus(benchmarkReturn).toString(),
        labelingVersion: 1,
        labeledAt: cutoff,
      };
      const insertion = await this.#database.query(
        `INSERT INTO protocol_flow_benchmark_outcomes
          (feature_id, horizon, benchmark_instrument_id, entry_event_id, exit_event_id,
           observation_at, target_at, exit_at, benchmark_entry_price, benchmark_exit_price,
           benchmark_return_pct, sol_return_pct, excess_return_pct, labeling_version,
           labeled_at, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$15)
         ON CONFLICT (feature_id, horizon, benchmark_instrument_id, labeling_version) DO NOTHING`,
        [
          identity.featureId,
          identity.horizon,
          identity.benchmarkInstrumentId,
          identity.entryEventId,
          identity.exitEventId,
          identity.observationAt,
          identity.targetAt,
          identity.exitAt,
          identity.benchmarkEntryPrice,
          identity.benchmarkExitPrice,
          identity.benchmarkReturnPct,
          identity.solReturnPct,
          identity.excessReturnPct,
          identity.labeledAt,
          contentHash(identity),
        ],
      );
      labeled += insertion.affectedRows ?? 0;
    }
    return labeled;
  }

  public async pumpSwapFlowResearchObservations(
    datasetCutoff: string,
  ): Promise<readonly CategoricalFlowObservation[]> {
    const result = await this.#database.query<{
      event_id: string;
      event_at: Date | string;
      horizon: CategoricalFlowObservation["horizon"];
      return_pct: string | number;
      prior_window_count: string | number;
      event_count_zscore: string | number | null;
      regime: string | null;
    }>(
      `SELECT flow.feature_id AS event_id, flow.window_end AS event_at,
              outcome.horizon, benchmark.excess_return_pct::text AS return_pct,
              flow.prior_window_count,
              flow.event_count_zscore::text, regime.state AS regime
       FROM protocol_flow_windows flow
       JOIN protocol_flow_forward_outcomes outcome
         ON outcome.feature_id = flow.feature_id AND outcome.labeling_version = 1
       JOIN protocol_flow_benchmark_outcomes benchmark
         ON benchmark.feature_id = outcome.feature_id AND benchmark.horizon = outcome.horizon
        AND benchmark.labeling_version = 1
       LEFT JOIN LATERAL (
         SELECT snapshot.state FROM market_regime_snapshots snapshot
         WHERE snapshot.as_of <= flow.window_end AND snapshot.state <> 'INSUFFICIENT_DATA'
         ORDER BY snapshot.as_of DESC, snapshot.regime_id DESC LIMIT 1
       ) regime ON true
       WHERE flow.protocol_key = 'PUMPSWAP_FEE_RECIPIENTS'
         AND flow.algorithm_version = 1 AND flow.window_end <= $1
       ORDER BY outcome.horizon, flow.window_start, flow.feature_id`,
      [toIsoTimestamp(datasetCutoff)],
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      eventAt: toIsoTimestamp(row.event_at),
      horizon: row.horizon,
      cohort: classifyPumpSwapFlowWindow(
        Number(row.prior_window_count),
        row.event_count_zscore === null ? undefined : Number(row.event_count_zscore),
      ),
      returnPct: Number(row.return_pct),
      ...(row.regime === null ? {} : { regime: row.regime }),
    }));
  }

  public async refreshEntityActivityRollup(
    datasetCutoff: string,
    maximumAddresses = 100_000,
    generatedAt = new Date().toISOString(),
  ): Promise<EntityActivityRollupResult> {
    const cutoff = toIsoTimestamp(datasetCutoff);
    const generated = toIsoTimestamp(generatedAt);
    if (!Number.isInteger(maximumAddresses) || maximumAddresses < 1 || maximumAddresses > 1_000_000)
      throw new Error("maximumAddresses must be between 1 and 1000000");
    const runId = deterministicDomainId("entity_rollup", `${cutoff}:${generated}:1`);
    return this.#database.transaction(async (transaction) => {
      const insertion = await transaction.query(
        `WITH resolved_events AS (
           SELECT event.event_time,
                  coalesce(from_owner.owner_address, from_address.address) AS from_address,
                  coalesce(to_owner.owner_address, to_address.address) AS to_address
           FROM capital_events event
           LEFT JOIN entity_addresses from_address ON from_address.entity_id = event.from_entity_id
           LEFT JOIN entity_addresses to_address ON to_address.entity_id = event.to_entity_id
           LEFT JOIN capital_event_owner_corrections from_owner
             ON from_owner.event_id = event.event_id AND from_owner.endpoint_side = 'FROM'
           LEFT JOIN capital_event_owner_corrections to_owner
             ON to_owner.event_id = event.event_id AND to_owner.endpoint_side = 'TO'
           WHERE event.event_time <= $2
         ), touches AS (
           SELECT from_address AS address, to_address AS counterparty_address,
                  false AS is_inflow, event_time
           FROM resolved_events WHERE from_address IS NOT NULL
           UNION ALL
           SELECT to_address AS address, from_address AS counterparty_address,
                  true AS is_inflow, event_time
           FROM resolved_events WHERE to_address IS NOT NULL
         ), ranked AS (
           SELECT address, count(*) AS event_count,
                  count(DISTINCT counterparty_address) AS unique_counterparty_count,
                  count(*) FILTER (WHERE is_inflow) AS inflow_event_count,
                  count(*) FILTER (WHERE NOT is_inflow) AS outflow_event_count,
                  min(event_time) AS first_seen_at, max(event_time) AS last_seen_at
           FROM touches GROUP BY address ORDER BY count(*) DESC, address LIMIT $3
         )
         INSERT INTO entity_activity_rollups
           (run_id, address, event_count, unique_counterparty_count, inflow_event_count,
            outflow_event_count, first_seen_at, last_seen_at)
         SELECT $1, address, event_count, unique_counterparty_count, inflow_event_count,
                outflow_event_count, first_seen_at, last_seen_at FROM ranked`,
        [runId, cutoff, maximumAddresses],
      );
      const count = await transaction.query<{ endpoint_event_count: string | number }>(
        `SELECT count(*) AS endpoint_event_count FROM capital_events
         WHERE event_time <= $1 AND from_entity_id IS NOT NULL
         UNION ALL
         SELECT count(*) AS endpoint_event_count FROM capital_events
         WHERE event_time <= $1 AND to_entity_id IS NOT NULL`,
        [cutoff],
      );
      const endpointEventCount = count.rows.reduce(
        (sum, row) => sum + Number(row.endpoint_event_count),
        0,
      );
      const addressCount = insertion.affectedRows ?? 0;
      const identity = {
        runId,
        datasetCutoff: cutoff,
        generatedAt: generated,
        algorithmVersion: 1,
        addressCount,
        endpointEventCount,
      };
      await transaction.query(
        `INSERT INTO entity_activity_rollup_runs
          (run_id, dataset_cutoff, generated_at, algorithm_version, address_count,
           event_count, record_hash) VALUES ($1,$2,$3,1,$4,$5,$6)`,
        [runId, cutoff, generated, addressCount, endpointEventCount, contentHash(identity)],
      );
      return {
        runId,
        datasetCutoff: cutoff,
        generatedAt: generated,
        addressCount,
        endpointEventCount,
      };
    });
  }

  public async persistEntityVerificationReview(input: EntityVerificationReview): Promise<boolean> {
    const review = EntityVerificationReviewSchema.parse(input);
    const reviewId = deterministicDomainId(
      "entity_review",
      `${review.address}:${review.decidedAt}:${review.status}:${review.reviewer}`,
    );
    const recordHash = contentHash(review);
    if (review.status === "VERIFIED") {
      const verified = await this.#database.query<{ present: number }>(
        `SELECT 1 AS present FROM verified_entity_addresses
         WHERE address = $1 AND entity_type = $2 AND label = $3 AND source = $4
           AND source_url = $5 AND evidence_hash = $6 AND valid_from = $7
           AND retrieved_at <= $8 LIMIT 1`,
        [
          review.address,
          review.proposedEntityType,
          review.proposedLabel,
          review.source,
          review.sourceUrl,
          review.evidenceHash,
          review.validFrom,
          review.decidedAt,
        ],
      );
      if (!verified.rows[0])
        throw new Error("VERIFIED review requires a matching imported, sourced attribution");
      const snapshot = await this.#database.query<{ present: number }>(
        `SELECT 1 AS present FROM entity_source_snapshots
         WHERE source_id = $1 AND source_url = $2 AND evidence_hash = $3
           AND retrieved_at <= $4 LIMIT 1`,
        [review.source, review.sourceUrl, review.evidenceHash, review.decidedAt],
      );
      if (!snapshot.rows[0])
        throw new Error("VERIFIED review requires a matching immutable source snapshot");
    }
    const result = await this.#database.query(
      `INSERT INTO entity_verification_reviews
        (review_id, address, status, decided_at, reviewer, rationale, proposed_entity_type,
         proposed_label, source, source_url, evidence_hash, valid_from, record_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (review_id) DO NOTHING`,
      [
        reviewId,
        review.address,
        review.status,
        review.decidedAt,
        review.reviewer,
        review.rationale,
        review.proposedEntityType ?? null,
        review.proposedLabel ?? null,
        review.source ?? null,
        review.sourceUrl ?? null,
        review.evidenceHash ?? null,
        review.validFrom ?? null,
        recordHash,
      ],
    );
    if ((result.affectedRows ?? 0) === 0) {
      const existing = await this.#database.query<{ record_hash: string }>(
        "SELECT record_hash FROM entity_verification_reviews WHERE review_id = $1",
        [reviewId],
      );
      if (existing.rows[0]?.record_hash !== recordHash)
        throw new Error(`entity review identity collision: ${reviewId}`);
    }
    return (result.affectedRows ?? 0) > 0;
  }

  public async latestEntityVerificationReviews(
    limit = 100,
  ): Promise<readonly StoredEntityVerificationReview[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
      throw new Error("limit must be between 1 and 1000");
    const result = await this.#database.query<{
      review_id: string;
      address: string;
      status: EntityVerificationReview["status"];
      decided_at: Date | string;
      reviewer: string;
      rationale: string;
      proposed_entity_type: EntityVerificationReview["proposedEntityType"] | null;
      proposed_label: string | null;
      source: string | null;
      source_url: string | null;
      evidence_hash: `sha256:${string}` | null;
      valid_from: Date | string | null;
    }>(
      `SELECT DISTINCT ON (address) review_id, address, status, decided_at, reviewer, rationale,
              proposed_entity_type, proposed_label, source, source_url, evidence_hash, valid_from
       FROM entity_verification_reviews
       ORDER BY address, decided_at DESC, review_id DESC LIMIT $1`,
      [limit],
    );
    return result.rows
      .map((row) => ({
        review: EntityVerificationReviewSchema.parse({
          address: row.address,
          status: row.status,
          decidedAt: toIsoTimestamp(row.decided_at),
          reviewer: row.reviewer,
          rationale: row.rationale,
          ...(row.proposed_entity_type === null
            ? {}
            : { proposedEntityType: row.proposed_entity_type }),
          ...(row.proposed_label === null ? {} : { proposedLabel: row.proposed_label }),
          ...(row.source === null ? {} : { source: row.source }),
          ...(row.source_url === null ? {} : { sourceUrl: row.source_url }),
          ...(row.evidence_hash === null ? {} : { evidenceHash: row.evidence_hash }),
          ...(row.valid_from === null ? {} : { validFrom: toIsoTimestamp(row.valid_from) }),
        }),
        reviewId: row.review_id,
      }))
      .map(({ review, reviewId }) => ({ ...review, reviewId }));
  }

  public async pendingSolanaOwnerExtractionHashes(
    limit = 100,
  ): Promise<readonly `sha256:${string}`[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
      throw new Error("limit must be between 1 and 10000");
    const result = await this.#database.query<{ raw_object_hash: `sha256:${string}` }>(
      `SELECT block.raw_object_hash
       FROM raw_chain_blocks block
       LEFT JOIN solana_owner_extractions extraction
         ON extraction.raw_object_hash = block.raw_object_hash
       WHERE block.chain = 'solana' AND extraction.raw_object_hash IS NULL
       ORDER BY block.source_time, block.slot LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => row.raw_object_hash);
  }

  public async persistSolanaOwnerExtraction(
    rawObjectHash: `sha256:${string}`,
    observations: readonly SolanaTokenAccountOwnerObservation[],
    extractedAt: string,
    extractorVersion = 1,
  ): Promise<SolanaOwnerExtractionResult> {
    const timestamp = toIsoTimestamp(extractedAt);
    if (!Number.isInteger(extractorVersion) || extractorVersion < 1)
      throw new Error("extractorVersion must be a positive integer");
    if (observations.some((item) => item.rawObjectHash !== rawObjectHash))
      throw new Error("owner observation raw-object hash mismatch");
    return this.#database.transaction(async (transaction) => {
      const rows = observations.map((observation) => ({
        token_account_address: observation.tokenAccountAddress,
        owner_address: observation.ownerAddress,
        mint: observation.mint,
        observed_at: observation.observedAt,
        raw_object_hash: rawObjectHash,
        record_hash: contentHash(observation),
      }));
      const observationInsert =
        rows.length === 0
          ? { affectedRows: 0 }
          : await transaction.query(
              `INSERT INTO solana_token_account_owner_observations
                (token_account_address, owner_address, mint, observed_at, raw_object_hash,
                 record_hash)
               SELECT token_account_address, owner_address, mint, observed_at, raw_object_hash,
                      record_hash
               FROM jsonb_to_recordset($1::jsonb) AS item(
                 token_account_address text, owner_address text, mint text,
                 observed_at timestamptz, raw_object_hash text, record_hash text)
               ON CONFLICT DO NOTHING`,
              [JSON.stringify(rows)],
            );
      const insertedObservationCount = observationInsert.affectedRows ?? 0;
      const identity = {
        rawObjectHash,
        extractedAt: timestamp,
        extractorVersion,
        observationCount: observations.length,
      };
      const extraction = await transaction.query(
        `INSERT INTO solana_owner_extractions
          (raw_object_hash, extracted_at, extractor_version, observation_count, record_hash)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (raw_object_hash) DO NOTHING`,
        [rawObjectHash, timestamp, extractorVersion, observations.length, contentHash(identity)],
      );
      if ((extraction.affectedRows ?? 0) === 0 && insertedObservationCount > 0)
        throw new Error("owner extraction identity collision");
      if ((extraction.affectedRows ?? 0) > 0)
        await transaction.query(
          `INSERT INTO capital_event_owner_corrections
            (event_id, endpoint_side, token_account_address, owner_address, raw_object_hash)
           SELECT event.event_id, endpoint.endpoint_side, endpoint.address,
                  observation.owner_address, event.raw_ref
           FROM capital_events event
           CROSS JOIN LATERAL (
             SELECT 'FROM'::text AS endpoint_side, mapping.address
             FROM entity_addresses mapping WHERE mapping.entity_id = event.from_entity_id
             UNION ALL
             SELECT 'TO'::text AS endpoint_side, mapping.address
             FROM entity_addresses mapping WHERE mapping.entity_id = event.to_entity_id
           ) endpoint
           JOIN solana_token_account_owner_observations observation
             ON observation.raw_object_hash = event.raw_ref
            AND observation.token_account_address = endpoint.address
           WHERE event.raw_ref = $1
           ON CONFLICT (event_id, endpoint_side) DO NOTHING`,
          [rawObjectHash],
        );
      return { rawObjectHash, observationCount: observations.length, insertedObservationCount };
    });
  }

  public async persistResearchAnalysisRun(candidate: ResearchAnalysisRun): Promise<boolean> {
    const identity = {
      ...candidate,
      status: candidate.result.status,
      observationCount: candidate.result.observationCount,
    };
    const recordHash = contentHash(identity);
    const result = await this.#database.query(
      `INSERT INTO research_analysis_runs
        (run_id, protocol_id, analysis_family, analysis_version, generated_at, status,
         observation_count, result, code_hash, dataset_hash, quality_manifest_id, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)
       ON CONFLICT (run_id) DO NOTHING`,
      [
        candidate.runId,
        candidate.protocolId,
        candidate.analysisFamily,
        candidate.analysisVersion,
        candidate.generatedAt,
        candidate.result.status,
        candidate.result.observationCount,
        JSON.stringify(candidate.result),
        candidate.codeHash,
        candidate.datasetHash,
        candidate.qualityManifestId ?? null,
        recordHash,
      ],
    );
    const inserted = (result.affectedRows ?? 0) > 0;
    if (!inserted) {
      const existing = await this.#database.query<{
        content_hash: string;
        code_hash: string;
        dataset_hash: string;
      }>(
        "SELECT content_hash, code_hash, dataset_hash FROM research_analysis_runs WHERE run_id = $1",
        [candidate.runId],
      );
      const stored = existing.rows[0];
      if (stored?.code_hash !== candidate.codeHash || stored.dataset_hash !== candidate.datasetHash)
        throw new Error(`research analysis identity collision: ${candidate.runId}`);
    }
    return inserted;
  }

  public async latestResearchQualityManifestId(at: string): Promise<string | undefined> {
    const result = await this.#database.query<{ manifest_id: string }>(
      `SELECT manifest_id FROM research_quality_manifests
       WHERE period_end <= $1 ORDER BY period_end DESC, generated_at DESC LIMIT 1`,
      [at],
    );
    return result.rows[0]?.manifest_id;
  }

  public async persistResearchQualityManifest(candidate: {
    readonly manifestId: string;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly generatedAt: string;
    readonly manifest: unknown;
    readonly codeHash: `sha256:${string}`;
  }): Promise<boolean> {
    const recordHash = contentHash(candidate);
    const result = await this.#database.query(
      `INSERT INTO research_quality_manifests
       (manifest_id,period_start,period_end,generated_at,manifest,code_hash,content_hash)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT (manifest_id) DO NOTHING`,
      [
        candidate.manifestId,
        candidate.periodStart,
        candidate.periodEnd,
        candidate.generatedAt,
        JSON.stringify(candidate.manifest),
        candidate.codeHash,
        recordHash,
      ],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  public async persistProviderCapabilityManifest(candidate: {
    readonly manifestId: string;
    readonly provider: "nansen" | "coinglass";
    readonly apiVersion: string;
    readonly probedAt: string;
    readonly capabilities: unknown;
    readonly rateMetadata: unknown;
    readonly parserVersion: number;
  }): Promise<boolean> {
    const recordHash = contentHash(candidate);
    const result = await this.#database.query(
      `INSERT INTO provider_capability_manifests
       (manifest_id,provider,api_version,probed_at,capabilities,rate_metadata,parser_version,content_hash)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) ON CONFLICT (manifest_id) DO NOTHING`,
      [
        candidate.manifestId,
        candidate.provider,
        candidate.apiVersion,
        candidate.probedAt,
        JSON.stringify(candidate.capabilities),
        JSON.stringify(candidate.rateMetadata),
        candidate.parserVersion,
        recordHash,
      ],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  public async persistProviderUsageMetric(candidate: {
    readonly usageId: string;
    readonly provider: "nansen" | "coinglass";
    readonly capability: string;
    readonly observedAt: string;
    readonly requestCount: number;
    readonly cacheHitCount: number;
    readonly coalescedCount: number;
    readonly restrictedCount: number;
    readonly errorCount: number;
    readonly creditsUsed?: number;
    readonly rateMetadata: unknown;
  }): Promise<boolean> {
    const recordHash = contentHash(candidate);
    const result = await this.#database.query(
      `INSERT INTO provider_usage_metrics
       (usage_id,provider,capability,observed_at,request_count,cache_hit_count,coalesced_count,
        restricted_count,error_count,credits_used,rate_metadata,content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
       ON CONFLICT (usage_id) DO NOTHING`,
      [
        candidate.usageId,
        candidate.provider,
        candidate.capability,
        candidate.observedAt,
        candidate.requestCount,
        candidate.cacheHitCount,
        candidate.coalescedCount,
        candidate.restrictedCount,
        candidate.errorCount,
        candidate.creditsUsed ?? null,
        JSON.stringify(candidate.rateMetadata),
        recordHash,
      ],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  public async providerRequestCountSince(
    provider: "nansen" | "coinglass",
    since: string,
  ): Promise<number> {
    const result = await this.#database.query<{ request_count: string | number }>(
      `SELECT COALESCE(sum(request_count), 0) AS request_count
       FROM provider_usage_metrics
       WHERE provider = $1 AND observed_at >= $2`,
      [provider, toIsoTimestamp(since)],
    );
    return Number(result.rows[0]?.request_count ?? 0);
  }

  public async providerCreditsUsedSince(
    provider: "nansen" | "coinglass",
    since: string,
  ): Promise<number> {
    const result = await this.#database.query<{ credits_used: string | number }>(
      `SELECT COALESCE(sum(credits_used), 0) AS credits_used
       FROM provider_usage_metrics
       WHERE provider = $1 AND observed_at >= $2`,
      [provider, toIsoTimestamp(since)],
    );
    return Number(result.rows[0]?.credits_used ?? 0);
  }

  public async cachedRawEnrichment(
    provider: "nansen" | "coinglass",
    capability: string,
    requestHash: `sha256:${string}`,
    retrievedSince: string,
  ): Promise<{ readonly retrievedAt: string; readonly responsePayload: unknown } | undefined> {
    const result = await this.#database.query<{
      retrieved_at: string | Date;
      response_payload: unknown;
    }>(
      `SELECT retrieved_at,response_payload
       FROM raw_enrichment_observations
       WHERE provider = $1 AND capability = $2 AND request_hash = $3
         AND retrieved_at >= $4 AND response_payload IS NOT NULL
       ORDER BY retrieved_at DESC LIMIT 1`,
      [provider, capability, requestHash, toIsoTimestamp(retrievedSince)],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return { retrievedAt: toIsoTimestamp(row.retrieved_at), responsePayload: row.response_payload };
  }

  public async persistRawEnrichment(candidate: {
    readonly rawEnrichmentId: string;
    readonly provider: "nansen" | "coinglass";
    readonly capability: string;
    readonly requestHash: `sha256:${string}`;
    readonly responseHash: `sha256:${string}`;
    readonly requestedAt: string;
    readonly retrievedAt: string;
    readonly requestMetadata: unknown;
    readonly responsePayload?: unknown;
    readonly retentionBasis: "FULL_RESPONSE" | "HASH_AND_METADATA";
    readonly parserVersion: number;
  }): Promise<boolean> {
    const recordHash = contentHash(candidate);
    const result = await this.#database.query(
      `INSERT INTO raw_enrichment_observations
       (raw_enrichment_id,provider,capability,request_hash,response_hash,requested_at,retrieved_at,
        request_metadata,response_payload,retention_basis,parser_version,content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)
       ON CONFLICT (raw_enrichment_id) DO NOTHING`,
      [
        candidate.rawEnrichmentId,
        candidate.provider,
        candidate.capability,
        candidate.requestHash,
        candidate.responseHash,
        candidate.requestedAt,
        candidate.retrievedAt,
        JSON.stringify(candidate.requestMetadata),
        candidate.responsePayload === undefined ? null : JSON.stringify(candidate.responsePayload),
        candidate.retentionBasis,
        candidate.parserVersion,
        recordHash,
      ],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  public async persistCanonicalEnrichment(candidate: {
    readonly observationId: string;
    readonly rawEnrichmentId: string;
    readonly provider: "nansen" | "coinglass";
    readonly observationType: string;
    readonly subject: string;
    readonly chain?: string | undefined;
    readonly scope: string;
    readonly metric: string;
    readonly value: unknown;
    readonly unit?: string | undefined;
    readonly eventAt?: string | undefined;
    readonly asOf?: string | undefined;
    readonly retrievedAt: string;
    readonly pointInTimeEligible: boolean;
    readonly retrospectiveOnly: boolean;
    readonly freshnessSeconds?: number | undefined;
    readonly quality: "VALID" | "STALE" | "RESTRICTED" | "MALFORMED";
    readonly parserVersion: number;
    readonly contentHash: `sha256:${string}`;
  }): Promise<boolean> {
    if (candidate.pointInTimeEligible && candidate.retrospectiveOnly)
      throw new Error("retrospective enrichment cannot be point-in-time eligible");
    const result = await this.#database.query(
      `INSERT INTO canonical_enrichment_observations
       (observation_id,raw_enrichment_id,provider,observation_type,subject,chain,scope,metric,value,
        unit,event_at,as_of,retrieved_at,point_in_time_eligible,retrospective_only,freshness_seconds,
        quality,parser_version,content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (observation_id) DO NOTHING`,
      [
        candidate.observationId,
        candidate.rawEnrichmentId,
        candidate.provider,
        candidate.observationType,
        candidate.subject,
        candidate.chain ?? null,
        candidate.scope,
        candidate.metric,
        JSON.stringify(candidate.value),
        candidate.unit ?? null,
        candidate.eventAt ?? null,
        candidate.asOf ?? null,
        candidate.retrievedAt,
        candidate.pointInTimeEligible,
        candidate.retrospectiveOnly,
        candidate.freshnessSeconds ?? null,
        candidate.quality,
        candidate.parserVersion,
        candidate.contentHash,
      ],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  public async enrichmentAblationPopulation(
    datasetCutoff: string,
    horizon: "1m" | "5m" | "15m" | "1h" | "6h" | "24h" = "15m",
    limit = 5_000,
  ): Promise<readonly string[]> {
    const cutoff = toIsoTimestamp(datasetCutoff);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50_000)
      throw new Error("ablation population limit must be between 1 and 50000");
    const rows = await this.#database.query<{ event_id: string }>(
      `WITH provider_start AS (
         SELECT min(retrieved_at) AS first_retrieved_at
         FROM canonical_enrichment_observations
         WHERE provider = 'nansen' AND point_in_time_eligible AND quality = 'VALID'
       )
       , eligible AS (
         SELECT event.event_id,event.event_time,
                row_number() OVER (
                  PARTITION BY date_bin(interval '5 minutes',event.event_time,timestamptz '1970-01-01')
                  ORDER BY event.event_time,event.event_id
                ) AS within_cluster_ordinal
         FROM capital_events event
         JOIN capital_event_forward_outcomes outcome
           ON outcome.event_id = event.event_id AND outcome.horizon = $2
         CROSS JOIN provider_start
         WHERE provider_start.first_retrieved_at IS NOT NULL
           AND event.event_time >= provider_start.first_retrieved_at
           AND event.event_time <= $1
           AND outcome.exit_at <= $1
       )
       SELECT event_id FROM eligible
       WHERE within_cluster_ordinal <= 20
       ORDER BY event_time,event_id LIMIT $3`,
      [cutoff, horizon, limit],
    );
    return rows.rows.map((row) => row.event_id);
  }

  public async enrichmentAblationTemporalClusterCount(
    eventIds: readonly string[],
    clusterMinutes = 5,
  ): Promise<number> {
    if (eventIds.length === 0) return 0;
    if (!Number.isInteger(clusterMinutes) || clusterMinutes < 1 || clusterMinutes > 1440)
      throw new Error("ablation cluster minutes must be between 1 and 1440");
    const result = await this.#database.query<{ count: string | number }>(
      `SELECT count(DISTINCT date_bin(
         $2 * interval '1 minute',event_time,timestamptz '1970-01-01'
       )) AS count
       FROM capital_events WHERE event_id = ANY($1::text[])`,
      [eventIds, clusterMinutes],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  public async persistEnrichmentAblationManifest(candidate: {
    readonly ablationId: string;
    readonly createdAt: string;
    readonly datasetCutoff: string;
    readonly variants: Readonly<Record<string, readonly string[]>>;
    readonly basePopulationHash: `sha256:${string}`;
    readonly outcomeDefinitionHash: `sha256:${string}`;
    readonly policyHash: `sha256:${string}`;
    readonly holdoutAccessed: false;
  }): Promise<boolean> {
    const normalized = {
      ...candidate,
      createdAt: toIsoTimestamp(candidate.createdAt),
      datasetCutoff: toIsoTimestamp(candidate.datasetCutoff),
    };
    const result = await this.#database.query(
      `INSERT INTO enrichment_ablation_manifests
       (ablation_id,created_at,dataset_cutoff,variants,base_population_hash,
        outcome_definition_hash,policy_hash,holdout_accessed,content_hash)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)
       ON CONFLICT (ablation_id) DO NOTHING`,
      [
        normalized.ablationId,
        normalized.createdAt,
        normalized.datasetCutoff,
        JSON.stringify(normalized.variants),
        normalized.basePopulationHash,
        normalized.outcomeDefinitionHash,
        normalized.policyHash,
        normalized.holdoutAccessed,
        contentHash(normalized),
      ],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  public async latestEnrichmentAblationEvaluationPopulation(): Promise<{
    readonly ablationId: string;
    readonly datasetCutoff: string;
    readonly rows: readonly EnrichmentAblationEvaluationRow[];
  } | null> {
    const manifest = await this.#database.query<{
      ablation_id: string;
      dataset_cutoff: Date | string;
    }>(
      `SELECT ablation_id,dataset_cutoff FROM enrichment_ablation_manifests
       WHERE holdout_accessed = false ORDER BY created_at DESC,ablation_id DESC LIMIT 1`,
    );
    const selected = manifest.rows[0];
    if (!selected) return null;
    const result = await this.#database.query<{
      event_id: string;
      event_time: Date | string;
      return_pct: string | number;
      normal_sol_return_pct: string | number;
      btc_return_pct: string | number | null;
      quantity: string | number;
      nansen_score: string | number | null;
      regime: string;
      magnitude_bucket: number;
    }>(
      `WITH selected_manifest AS (
         SELECT variants FROM enrichment_ablation_manifests WHERE ablation_id = $1
       ), population AS (
         SELECT value AS event_id
         FROM selected_manifest,jsonb_array_elements_text(variants->'CFIE_BASE') value
       ), observations AS (
         SELECT event.event_id,event.event_time,event.quantity,
                outcome.return_pct,
                avg(outcome.return_pct) OVER () AS normal_sol_return_pct,
                benchmark.benchmark_return_pct AS btc_return_pct,
                COALESCE(regime.state,'UNSPECIFIED') AS regime,
                nansen.nansen_score
         FROM population
         JOIN capital_events event ON event.event_id = population.event_id
         JOIN capital_event_forward_outcomes outcome
           ON outcome.event_id = event.event_id AND outcome.horizon = '15m'
         LEFT JOIN LATERAL (
           SELECT candidate.benchmark_return_pct
           FROM capital_event_benchmark_outcomes candidate
           WHERE candidate.event_id = event.event_id AND candidate.horizon = '15m'
           ORDER BY candidate.labeling_version DESC,candidate.benchmark_instrument_id
           LIMIT 1
         ) benchmark ON true
         LEFT JOIN LATERAL (
           SELECT candidate.state FROM market_regime_snapshots candidate
           WHERE candidate.as_of <= event.event_time
           ORDER BY candidate.as_of DESC,candidate.regime_id DESC LIMIT 1
         ) regime ON true
         LEFT JOIN LATERAL (
           SELECT avg(COALESCE((candidate.feature->>'holdingsValueDeltaPct')::double precision,0))
                    AS nansen_score
           FROM nansen_change_features candidate
           WHERE candidate.current_retrieved_at = (
             SELECT max(latest.current_retrieved_at) FROM nansen_change_features latest
             WHERE latest.current_retrieved_at <= event.event_time
           )
         ) nansen ON true
       ), bucketed AS (
         SELECT observations.*,
                ntile(4) OVER (ORDER BY quantity,event_id) AS magnitude_bucket
         FROM observations
       )
       SELECT * FROM bucketed ORDER BY event_time,event_id`,
      [selected.ablation_id],
    );
    return {
      ablationId: selected.ablation_id,
      datasetCutoff: toIsoTimestamp(selected.dataset_cutoff),
      rows: result.rows.map((row) => ({
        eventId: row.event_id,
        eventTime: toIsoTimestamp(row.event_time),
        returnPct: Number(row.return_pct),
        normalSolReturnPct: Number(row.normal_sol_return_pct),
        btcReturnPct: row.btc_return_pct === null ? null : Number(row.btc_return_pct),
        quantity: Number(row.quantity),
        nansenScore: row.nansen_score === null ? null : Number(row.nansen_score),
        regime: row.regime,
        magnitudeBucket: `Q${String(row.magnitude_bucket)}`,
      })),
    };
  }

  public async persistEnrichmentAblationEvaluation(candidate: {
    readonly evaluationId: string;
    readonly ablationId: string;
    readonly generatedAt: string;
    readonly datasetCutoff: string;
    readonly evaluationVersion: number;
    readonly observationCount: number;
    readonly eventTimeClusterCount: number;
    readonly result: unknown;
    readonly codeHash: `sha256:${string}`;
    readonly holdoutAccessed: false;
  }): Promise<boolean> {
    const normalized = {
      ...candidate,
      generatedAt: toIsoTimestamp(candidate.generatedAt),
      datasetCutoff: toIsoTimestamp(candidate.datasetCutoff),
    };
    const inserted = await this.#database.query(
      `INSERT INTO enrichment_ablation_evaluations
       (evaluation_id,ablation_id,generated_at,dataset_cutoff,evaluation_version,
        observation_count,event_time_cluster_count,result,code_hash,holdout_accessed,content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
       ON CONFLICT (evaluation_id) DO NOTHING`,
      [
        normalized.evaluationId,
        normalized.ablationId,
        normalized.generatedAt,
        normalized.datasetCutoff,
        normalized.evaluationVersion,
        normalized.observationCount,
        normalized.eventTimeClusterCount,
        JSON.stringify(normalized.result),
        normalized.codeHash,
        normalized.holdoutAccessed,
        contentHash(normalized),
      ],
    );
    return (inserted.affectedRows ?? 0) > 0;
  }

  public async nansenMetricSnapshots(limit = 10_000): Promise<readonly NansenMetricSnapshot[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100_000)
      throw new Error("Nansen metric limit must be between 1 and 100000");
    const result = await this.#database.query<{
      observation_id: string;
      subject: string;
      scope: string;
      retrieved_at: Date | string;
      metric: string;
      value: unknown;
    }>(
      `SELECT observation_id,subject,scope,retrieved_at,metric,value
       FROM canonical_enrichment_observations
       WHERE provider = 'nansen'
         AND observation_type = 'SMART_MONEY_HOLDINGS'
         AND point_in_time_eligible
         AND quality = 'VALID'
       ORDER BY retrieved_at DESC,subject,metric
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => {
      const numericValue = Number(row.value);
      if (!Number.isFinite(numericValue)) throw new Error("invalid stored Nansen metric value");
      return {
        observationId: row.observation_id,
        subject: row.subject,
        symbol: row.scope.startsWith("NANSEN_SMART_MONEY:")
          ? row.scope.slice("NANSEN_SMART_MONEY:".length)
          : row.scope,
        retrievedAt: toIsoTimestamp(row.retrieved_at),
        metric: row.metric,
        value: numericValue,
      };
    });
  }

  public async persistNansenChangeFeature(
    featureId: string,
    feature: NansenChangeFeature,
  ): Promise<boolean> {
    const candidate = {
      featureId,
      ...feature,
      pointInTimeEligible: true as const,
      parserVersion: 1,
    };
    const result = await this.#database.query(
      `INSERT INTO nansen_change_features
       (feature_id,subject,symbol,previous_retrieved_at,current_retrieved_at,feature,
        source_observation_ids,point_in_time_eligible,parser_version,content_hash)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)
       ON CONFLICT (feature_id) DO NOTHING`,
      [
        candidate.featureId,
        candidate.subject,
        candidate.symbol,
        candidate.previousRetrievedAt,
        candidate.currentRetrievedAt,
        JSON.stringify(feature),
        JSON.stringify(candidate.sourceObservationIds),
        candidate.pointInTimeEligible,
        candidate.parserVersion,
        contentHash(candidate),
      ],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  public async persistHypothesisAttempt(candidate: {
    readonly attemptId: string;
    readonly protocolId?: string;
    readonly family: string;
    readonly familyVersion: number;
    readonly tier: "EXPLORATORY" | "CONFIRMATORY";
    readonly definition: unknown;
    readonly registeredAt: string;
    readonly status: "REGISTERED" | "TESTED" | "REJECTED" | "PROMOTION_ELIGIBLE";
    readonly codeHash: `sha256:${string}`;
    readonly configHash: `sha256:${string}`;
  }): Promise<boolean> {
    const definitionHash = contentHash(candidate.definition);
    const recordHash = contentHash({ ...candidate, definitionHash });
    const result = await this.#database.query(
      `INSERT INTO research_hypothesis_attempts
       (attempt_id,protocol_id,family,family_version,tier,definition,definition_hash,
        registered_at,status,code_hash,config_hash,content_hash)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (attempt_id) DO NOTHING`,
      [
        candidate.attemptId,
        candidate.protocolId ?? null,
        candidate.family,
        candidate.familyVersion,
        candidate.tier,
        JSON.stringify(candidate.definition),
        definitionHash,
        candidate.registeredAt,
        candidate.status,
        candidate.codeHash,
        candidate.configHash,
        recordHash,
      ],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  public async persistNegativeKnowledge(candidate: {
    readonly rejectionId: string;
    readonly attemptId: string;
    readonly rejectedAt: string;
    readonly observationPeriodStart: string;
    readonly observationPeriodEnd: string;
    readonly reasonCode: string;
    readonly statisticalResult: unknown;
    readonly economicResult: unknown;
    readonly codeHash: `sha256:${string}`;
    readonly configHash: `sha256:${string}`;
  }): Promise<boolean> {
    const recordHash = contentHash(candidate);
    const result = await this.#database.query(
      `INSERT INTO negative_knowledge_registry
       (rejection_id,attempt_id,rejected_at,observation_period_start,observation_period_end,
        reason_code,statistical_result,economic_result,code_hash,config_hash,content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)
       ON CONFLICT (rejection_id) DO NOTHING`,
      [
        candidate.rejectionId,
        candidate.attemptId,
        candidate.rejectedAt,
        candidate.observationPeriodStart,
        candidate.observationPeriodEnd,
        candidate.reasonCode,
        JSON.stringify(candidate.statisticalResult),
        JSON.stringify(candidate.economicResult),
        candidate.codeHash,
        candidate.configHash,
        recordHash,
      ],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  public async persistPromotionRecord(candidate: {
    readonly promotionId: string;
    readonly attemptId: string;
    readonly protocolId: string;
    readonly developmentRunId: string;
    readonly createdAt: string;
    readonly decision: "REJECTED" | "APPROVED_FOR_ONE_SHOT_HOLDOUT";
    readonly gateResult: Readonly<Record<string, unknown>>;
    readonly futureHoldoutStart: string;
    readonly futureHoldoutEnd: string;
  }): Promise<boolean> {
    const createdAt = toIsoTimestamp(candidate.createdAt);
    const futureHoldoutStart = toIsoTimestamp(candidate.futureHoldoutStart);
    const futureHoldoutEnd = toIsoTimestamp(candidate.futureHoldoutEnd);
    if (futureHoldoutStart <= createdAt)
      throw new Error("future holdout must begin strictly after the promotion decision");
    if (futureHoldoutEnd <= futureHoldoutStart)
      throw new Error("future holdout end must be after its start");
    if (
      candidate.decision === "APPROVED_FOR_ONE_SHOT_HOLDOUT" &&
      candidate.gateResult.eligible !== true
    )
      throw new Error("holdout approval requires an explicitly eligible promotion gate");
    const normalized = {
      ...candidate,
      createdAt,
      futureHoldoutStart,
      futureHoldoutEnd,
    };
    const recordHash = contentHash(normalized);
    const result = await this.#database.query(
      `INSERT INTO research_promotion_records
       (promotion_id,attempt_id,protocol_id,development_run_id,created_at,decision,
        gate_result,future_holdout_start,future_holdout_end,content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
       ON CONFLICT (promotion_id) DO NOTHING`,
      [
        candidate.promotionId,
        candidate.attemptId,
        candidate.protocolId,
        candidate.developmentRunId,
        createdAt,
        candidate.decision,
        JSON.stringify(candidate.gateResult),
        futureHoldoutStart,
        futureHoldoutEnd,
        recordHash,
      ],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  public async phaseTwoResearchStatus(): Promise<{
    readonly qualityManifestCount: number;
    readonly hypothesisAttemptCount: number;
    readonly rejectionCount: number;
    readonly promotionCount: number;
    readonly findingSummary: {
      readonly verdict:
        | "PROMOTED_FOR_HOLDOUT"
        | "HUMAN_REVIEW_REQUIRED"
        | "NO_SUPPORTED_EDGE"
        | "NO_FINDINGS";
      readonly supported: number;
      readonly notSupported: number;
      readonly insufficientData: number;
      readonly invalidatedDataQuality: number;
      readonly latestObservationCount: number;
      readonly latestEpisodeCount: number | null;
      readonly corpusEpisodeCount: number;
      readonly attributedCorpusEpisodeCount: number;
      readonly corpusUtcDayCount: number;
      readonly directionallyAttributedEpisodeCount: number;
      readonly latestAttributionQuality?: string;
      readonly latestHumanReviewAction?: string;
      readonly latestGeneratedAt?: string;
    };
    readonly sealedEpisodeProtocol?: {
      readonly protocolId: string;
      readonly version: number;
      readonly frozenAt: string;
      readonly datasetCutoff: string;
      readonly status: "SEALED_COLLECTING" | "MATURED";
    };
    readonly episodeReadiness: {
      readonly status: "READY" | "COLLECTING";
      readonly gatesPassed: number;
      readonly gateCount: number;
      readonly verifiedEntityClassCount: number;
      readonly qualifiedDirectionCohortCount: number;
      readonly gates: readonly {
        readonly gate: string;
        readonly current: number;
        readonly required: number;
        readonly unit: "COUNT" | "PERCENT";
        readonly passed: boolean;
      }[];
    };
    readonly attempts: readonly {
      readonly attemptId: string;
      readonly family: string;
      readonly familyVersion: number;
      readonly tier: string;
      readonly status: string;
      readonly registeredAt: string;
      readonly rejected: boolean;
      readonly promotionDecision?: string;
    }[];
  }> {
    const counts = await this.#database.query<{
      manifests: string | number;
      attempts: string | number;
      rejections: string | number;
      promotions: string | number;
    }>(`SELECT
      (SELECT count(*) FROM research_quality_manifests) AS manifests,
      (SELECT count(*) FROM research_hypothesis_attempts) AS attempts,
      (SELECT count(*) FROM negative_knowledge_registry) AS rejections,
      (SELECT count(*) FROM research_promotion_records) AS promotions`);
    const [attempts, findings, sealedProtocols, readiness] = await Promise.all([
      this.#database.query<{
        attempt_id: string;
        family: string;
        family_version: number;
        tier: string;
        status: string;
        registered_at: Date | string;
        rejection_id: string | null;
        decision: string | null;
      }>(`SELECT attempt.attempt_id, attempt.family, attempt.family_version, attempt.tier,
              attempt.status, attempt.registered_at, rejection.rejection_id, promotion.decision
       FROM research_hypothesis_attempts attempt
       LEFT JOIN negative_knowledge_registry rejection USING (attempt_id)
       LEFT JOIN research_promotion_records promotion USING (attempt_id)
       ORDER BY attempt.registered_at DESC, attempt.family, attempt.attempt_id LIMIT 100`),
      this.#database.query<{
        supported: string | number;
        not_supported: string | number;
        insufficient_data: string | number;
        invalidated_data_quality: string | number;
        observation_count: string | number | null;
        episode_count: string | number | null;
        attribution_quality: string | null;
        human_review_action: string | null;
        generated_at: Date | string | null;
        corpus_episode_count: string | number;
        attributed_corpus_episode_count: string | number;
        corpus_utc_day_count: string | number;
        directionally_attributed_episode_count: string | number;
      }>(`WITH totals AS (
             SELECT count(*) FILTER (WHERE classification = 'SUPPORTED') AS supported,
                    count(*) FILTER (WHERE classification = 'NOT_SUPPORTED') AS not_supported,
                    count(*) FILTER (WHERE classification = 'INSUFFICIENT_DATA') AS insufficient_data,
                    count(*) FILTER (WHERE classification = 'INVALIDATED_DATA_QUALITY')
                      AS invalidated_data_quality
             FROM research_finding_packets
           ), latest AS (
             SELECT (packet->>'observationCount')::bigint AS observation_count,
                    NULLIF(packet->>'episodeCount', '')::bigint AS episode_count,
                    packet->>'attributionQuality' AS attribution_quality,
                    packet->>'humanReviewAction' AS human_review_action,
                    generated_at
             FROM research_finding_packets
             ORDER BY generated_at DESC, packet_hash DESC LIMIT 1
           ), corpus AS (
             SELECT count(*) AS corpus_episode_count,
                    count(*) FILTER (WHERE quality IN ('ATTRIBUTED', 'VERIFIED_CONTEXT'))
                      AS attributed_corpus_episode_count,
                    count(DISTINCT (window_start AT TIME ZONE 'UTC')::date)
                      AS corpus_utc_day_count,
                    count(*) FILTER (WHERE direction <> 'UNKNOWN→UNKNOWN')
                      AS directionally_attributed_episode_count
             FROM capital_flow_episodes
           )
           SELECT totals.*, latest.observation_count, latest.episode_count,
                  latest.attribution_quality, latest.human_review_action, latest.generated_at,
                  corpus.*
           FROM totals CROSS JOIN corpus LEFT JOIN latest ON true`),
      this.#database.query<{
        protocol_id: string;
        version: number;
        frozen_at: Date | string;
        dataset_cutoff: Date | string;
      }>(`SELECT protocol_id,version,frozen_at,dataset_cutoff
           FROM research_protocols
           WHERE name = 'CFIE Research Phase 1 — Episode-Level Capital Flow Signal Protocol'
           ORDER BY version DESC LIMIT 1`),
      this.#database.query<{
        episode_count: string | number;
        attributed_episode_count: string | number;
        utc_day_count: string | number;
        qualified_direction_cohort_count: string | number;
        minimum_qualified_direction_count: string | number;
        verified_entity_class_count: string | number;
        benchmarked_episode_count: string | number;
      }>(`WITH episode AS (
             SELECT count(*) AS episode_count,
                    count(*) FILTER (WHERE quality IN ('ATTRIBUTED', 'VERIFIED_CONTEXT'))
                      AS attributed_episode_count,
                    count(DISTINCT (window_start AT TIME ZONE 'UTC')::date) AS utc_day_count
             FROM capital_flow_episodes
           ), direction AS (
             SELECT count(*) AS direction_count
             FROM capital_flow_episodes
             WHERE direction <> 'UNKNOWN→UNKNOWN'
             GROUP BY direction
           ), benchmarked AS (
             SELECT count(DISTINCT episode.episode_id) AS benchmarked_episode_count
             FROM capital_flow_episodes episode
             JOIN capital_event_benchmark_outcomes outcome
               ON outcome.event_id = episode.anchor_event_id
           )
           SELECT episode.*,
                  count(*) FILTER (WHERE direction.direction_count >= 100)
                    AS qualified_direction_cohort_count,
                  COALESCE(min(direction.direction_count)
                    FILTER (WHERE direction.direction_count >= 100), 0)
                    AS minimum_qualified_direction_count,
                  (SELECT count(DISTINCT entity_type) FROM verified_entity_addresses)
                    AS verified_entity_class_count,
                  benchmarked.benchmarked_episode_count
           FROM episode CROSS JOIN benchmarked LEFT JOIN direction ON true
           GROUP BY episode.episode_count,episode.attributed_episode_count,
                    episode.utc_day_count,benchmarked.benchmarked_episode_count`),
    ]);
    const row = counts.rows[0];
    const finding = findings.rows[0];
    const promotionCount = Number(row?.promotions ?? 0);
    const supported = Number(finding?.supported ?? 0);
    const findingCount =
      supported +
      Number(finding?.not_supported ?? 0) +
      Number(finding?.insufficient_data ?? 0) +
      Number(finding?.invalidated_data_quality ?? 0);
    const sealedProtocol = sealedProtocols.rows[0];
    const readinessRow = readiness.rows[0];
    const episodeCount = Number(readinessRow?.episode_count ?? 0);
    const attributedEpisodeCount = Number(readinessRow?.attributed_episode_count ?? 0);
    const readinessGates = [
      {
        gate: "Independent UTC days",
        current: Number(readinessRow?.utc_day_count ?? 0),
        required: 21,
        unit: "COUNT" as const,
      },
      {
        gate: "Attributed episode coverage",
        current: episodeCount === 0 ? 0 : (attributedEpisodeCount / episodeCount) * 100,
        required: 10,
        unit: "PERCENT" as const,
      },
      {
        gate: "Episodes in each qualified direction",
        current: Number(readinessRow?.minimum_qualified_direction_count ?? 0),
        required: 100,
        unit: "COUNT" as const,
      },
      {
        gate: "BTC-relative benchmarked episodes",
        current: Number(readinessRow?.benchmarked_episode_count ?? 0),
        required: 100,
        unit: "COUNT" as const,
      },
    ].map((gate) => ({ ...gate, passed: gate.current >= gate.required }));
    return {
      qualityManifestCount: Number(row?.manifests ?? 0),
      hypothesisAttemptCount: Number(row?.attempts ?? 0),
      rejectionCount: Number(row?.rejections ?? 0),
      promotionCount,
      findingSummary: {
        verdict:
          promotionCount > 0
            ? "PROMOTED_FOR_HOLDOUT"
            : supported > 0
              ? "HUMAN_REVIEW_REQUIRED"
              : findingCount > 0
                ? "NO_SUPPORTED_EDGE"
                : "NO_FINDINGS",
        supported,
        notSupported: Number(finding?.not_supported ?? 0),
        insufficientData: Number(finding?.insufficient_data ?? 0),
        invalidatedDataQuality: Number(finding?.invalidated_data_quality ?? 0),
        latestObservationCount: Number(finding?.observation_count ?? 0),
        latestEpisodeCount:
          finding?.episode_count === null || finding?.episode_count === undefined
            ? null
            : Number(finding.episode_count),
        corpusEpisodeCount: Number(finding?.corpus_episode_count ?? 0),
        attributedCorpusEpisodeCount: Number(finding?.attributed_corpus_episode_count ?? 0),
        corpusUtcDayCount: Number(finding?.corpus_utc_day_count ?? 0),
        directionallyAttributedEpisodeCount: Number(
          finding?.directionally_attributed_episode_count ?? 0,
        ),
        ...(finding?.attribution_quality
          ? { latestAttributionQuality: finding.attribution_quality }
          : {}),
        ...(finding?.human_review_action
          ? { latestHumanReviewAction: finding.human_review_action }
          : {}),
        ...(finding?.generated_at
          ? { latestGeneratedAt: toIsoTimestamp(finding.generated_at) }
          : {}),
      },
      ...(sealedProtocol
        ? {
            sealedEpisodeProtocol: {
              protocolId: sealedProtocol.protocol_id,
              version: sealedProtocol.version,
              frozenAt: toIsoTimestamp(sealedProtocol.frozen_at),
              datasetCutoff: toIsoTimestamp(sealedProtocol.dataset_cutoff),
              status:
                Date.now() < new Date(sealedProtocol.dataset_cutoff).getTime()
                  ? ("SEALED_COLLECTING" as const)
                  : ("MATURED" as const),
            },
          }
        : {}),
      episodeReadiness: {
        status: readinessGates.every((gate) => gate.passed) ? "READY" : "COLLECTING",
        gatesPassed: readinessGates.filter((gate) => gate.passed).length,
        gateCount: readinessGates.length,
        verifiedEntityClassCount: Number(readinessRow?.verified_entity_class_count ?? 0),
        qualifiedDirectionCohortCount: Number(readinessRow?.qualified_direction_cohort_count ?? 0),
        gates: readinessGates,
      },
      attempts: attempts.rows.map((attempt) => ({
        attemptId: attempt.attempt_id,
        family: attempt.family,
        familyVersion: attempt.family_version,
        tier: attempt.tier,
        status: attempt.status,
        registeredAt: toIsoTimestamp(attempt.registered_at),
        rejected: attempt.rejection_id !== null,
        ...(attempt.decision === null ? {} : { promotionDecision: attempt.decision }),
      })),
    };
  }

  public async enrichmentStatus(): Promise<{
    readonly capabilityManifestCount: number;
    readonly usageMetricCount: number;
    readonly rawObservationCount: number;
    readonly canonicalObservationCount: number;
    readonly incidentCount: number;
    readonly ablationManifestCount: number;
    readonly ablationEvaluationCount: number;
    readonly latestAblationEvaluation?: unknown;
    readonly pointInTimeEligibleCount: number;
    readonly nansenFeatureCount: number;
    readonly nansenSnapshotCount: number;
    readonly nansenRequestsToday: number;
    readonly estimatedCreditsToday: number;
    readonly maximumDailyRequests: number;
    readonly latestNansenSnapshotAt?: string;
    readonly nansenStalenessSeconds?: number;
    readonly nansenGapCount: number;
    readonly latestNansenFeatures: readonly NansenChangeFeature[];
    readonly latestCapabilities: readonly {
      readonly provider: string;
      readonly apiVersion: string;
      readonly probedAt: string;
      readonly capabilities: unknown;
    }[];
  }> {
    const counts = await this.#database.query<{
      manifests: string | number;
      usage: string | number;
      raw: string | number;
      canonical: string | number;
      incidents: string | number;
      ablations: string | number;
      ablation_evaluations: string | number;
      point_in_time: string | number;
      nansen_features: string | number;
      nansen_snapshots: string | number;
      nansen_requests_today: string | number;
      latest_nansen_snapshot_at: Date | string | null;
    }>(`SELECT
      (SELECT count(*) FROM provider_capability_manifests) AS manifests,
      (SELECT count(*) FROM provider_usage_metrics) AS usage,
      (SELECT count(*) FROM raw_enrichment_observations) AS raw,
      (SELECT count(*) FROM canonical_enrichment_observations) AS canonical,
      (SELECT count(*) FROM provider_enrichment_incidents) AS incidents,
      (SELECT count(*) FROM enrichment_ablation_manifests) AS ablations,
      (SELECT count(*) FROM enrichment_ablation_evaluations) AS ablation_evaluations,
      (SELECT count(*) FROM canonical_enrichment_observations
       WHERE point_in_time_eligible AND quality = 'VALID') AS point_in_time,
      (SELECT count(*) FROM nansen_change_features) AS nansen_features,
      (SELECT count(DISTINCT retrieved_at) FROM canonical_enrichment_observations
       WHERE provider = 'nansen' AND point_in_time_eligible AND quality = 'VALID') AS nansen_snapshots,
      (SELECT COALESCE(sum(request_count), 0) FROM provider_usage_metrics
       WHERE provider = 'nansen' AND observed_at >= date_trunc('day', now())) AS nansen_requests_today,
      (SELECT max(retrieved_at) FROM canonical_enrichment_observations
       WHERE provider = 'nansen' AND point_in_time_eligible AND quality = 'VALID')
       AS latest_nansen_snapshot_at`);
    const capabilities = await this.#database.query<{
      provider: string;
      api_version: string;
      probed_at: Date | string;
      capabilities: unknown;
    }>(`SELECT DISTINCT ON (provider) provider,api_version,probed_at,capabilities
       FROM provider_capability_manifests
       ORDER BY provider,probed_at DESC,manifest_id DESC`);
    const row = counts.rows[0];
    const gaps = await this.#database.query<{ gap_count: string | number }>(
      `WITH snapshots AS (
         SELECT DISTINCT retrieved_at
         FROM canonical_enrichment_observations
         WHERE provider = 'nansen' AND point_in_time_eligible AND quality = 'VALID'
       ), ordered AS (
         SELECT retrieved_at,lag(retrieved_at) OVER (ORDER BY retrieved_at) AS previous_at
         FROM snapshots
       )
       SELECT count(*) AS gap_count FROM ordered
       WHERE previous_at IS NOT NULL AND retrieved_at - previous_at > interval '90 minutes'`,
    );
    const latestFeatures = await this.#database.query<{ feature: NansenChangeFeature }>(
      `SELECT feature FROM nansen_change_features
       ORDER BY current_retrieved_at DESC,subject LIMIT 10`,
    );
    const latestEvaluation = await this.#database.query<{ result: unknown }>(
      `SELECT result FROM enrichment_ablation_evaluations
       ORDER BY generated_at DESC,evaluation_id DESC LIMIT 1`,
    );
    const latestNansenSnapshotAt = row?.latest_nansen_snapshot_at
      ? toIsoTimestamp(row.latest_nansen_snapshot_at)
      : undefined;
    const stalenessSeconds = latestNansenSnapshotAt
      ? Math.max(0, Math.floor((Date.now() - new Date(latestNansenSnapshotAt).getTime()) / 1000))
      : undefined;
    return {
      capabilityManifestCount: Number(row?.manifests ?? 0),
      usageMetricCount: Number(row?.usage ?? 0),
      rawObservationCount: Number(row?.raw ?? 0),
      canonicalObservationCount: Number(row?.canonical ?? 0),
      incidentCount: Number(row?.incidents ?? 0),
      ablationManifestCount: Number(row?.ablations ?? 0),
      ablationEvaluationCount: Number(row?.ablation_evaluations ?? 0),
      ...(latestEvaluation.rows[0] === undefined
        ? {}
        : { latestAblationEvaluation: latestEvaluation.rows[0].result }),
      pointInTimeEligibleCount: Number(row?.point_in_time ?? 0),
      nansenFeatureCount: Number(row?.nansen_features ?? 0),
      nansenSnapshotCount: Number(row?.nansen_snapshots ?? 0),
      nansenRequestsToday: Number(row?.nansen_requests_today ?? 0),
      estimatedCreditsToday: Number(row?.nansen_requests_today ?? 0) * 5,
      maximumDailyRequests: 24,
      ...(latestNansenSnapshotAt === undefined ? {} : { latestNansenSnapshotAt }),
      ...(stalenessSeconds === undefined ? {} : { nansenStalenessSeconds: stalenessSeconds }),
      nansenGapCount: Number(gaps.rows[0]?.gap_count ?? 0),
      latestNansenFeatures: latestFeatures.rows.map((item) => item.feature),
      latestCapabilities: capabilities.rows.map((item) => ({
        provider: item.provider,
        apiVersion: item.api_version,
        probedAt: toIsoTimestamp(item.probed_at),
        capabilities: item.capabilities,
      })),
    };
  }

  public async persistHoldoutAccessAudit(candidate: {
    readonly protocolId: string;
    readonly runId: string;
    readonly accessedAt: string;
    readonly datasetHash: `sha256:${string}`;
    readonly codeRevision: string;
    readonly protocolVersion: number;
    readonly promotionEvidenceHash: `sha256:${string}`;
    readonly resultHash: `sha256:${string}`;
  }): Promise<boolean> {
    const identity = { ...candidate, auditVersion: 1 };
    const recordHash = contentHash(identity);
    const auditId = deterministicDomainId(
      "holdout_audit",
      `${candidate.protocolId}:${candidate.runId}`,
    );
    const result = await this.#database.query(
      `INSERT INTO holdout_access_audit
        (audit_id, protocol_id, run_id, accessed_at, dataset_hash, code_revision,
         protocol_version, promotion_evidence_hash, result_hash, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (protocol_id, run_id) DO NOTHING`,
      [
        auditId,
        candidate.protocolId,
        candidate.runId,
        candidate.accessedAt,
        candidate.datasetHash,
        candidate.codeRevision,
        candidate.protocolVersion,
        candidate.promotionEvidenceHash,
        candidate.resultHash,
        recordHash,
      ],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  public async researchFindingPacket(
    packetHash: `sha256:${string}`,
    protocolId: string,
    hypothesisId: string,
  ): Promise<unknown> {
    const result = await this.#database.query<{ packet: unknown }>(
      `SELECT packet FROM research_finding_packets
       WHERE packet_hash = $1 AND protocol_id = $2 AND hypothesis_id = $3`,
      [packetHash, protocolId, hypothesisId],
    );
    return result.rows[0]?.packet;
  }

  public async persistResearchFindingPacket(packet: ResearchFindingPacket): Promise<boolean> {
    const result = await this.#database.query(
      `INSERT INTO research_finding_packets
        (packet_hash, protocol_id, run_id, hypothesis_id, classification, generated_at, packet)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (protocol_id, run_id, hypothesis_id) DO NOTHING`,
      [
        packet.contentHash,
        packet.protocolId,
        packet.runId,
        packet.hypothesisId,
        packet.classification,
        packet.generatedAt,
        JSON.stringify(packet),
      ],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  public async persistCapture(
    summary: CollectionRunSummary,
    records: readonly CaptureRecord[],
    failures: readonly CaptureFailure[] = [],
  ): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO collection_runs
          (collection_run_id, source, started_at, completed_at, requested_assets,
           captured_observations, error_count, status, details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [
          summary.collectionRunId,
          summary.source,
          summary.startedAt,
          summary.completedAt,
          summary.requestedAssets,
          summary.capturedObservations,
          summary.errorCount,
          summary.status,
          JSON.stringify(summary.details),
        ],
      );
      for (const record of records) await this.#persistRecord(transaction, record);
      for (const [index, failure] of failures.entries()) {
        await transaction.query(
          `INSERT INTO collection_errors
            (collection_error_id, collection_run_id, mint, occurred_at, error_code, message)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            deterministicDomainId(
              "collection_error",
              `${summary.collectionRunId}:${String(index)}:${failure.mint}`,
            ),
            summary.collectionRunId,
            failure.mint,
            failure.occurredAt,
            failure.errorCode,
            failure.message,
          ],
        );
      }
    });
  }

  async #persistRecord(transaction: SqlTransaction, record: CaptureRecord): Promise<void> {
    const rawRecordHash = record.normalized.rawObservationHash;
    await transaction.query(
      `INSERT INTO raw_observations
        (observation_id, ingestion_id, source, source_id, observed_at, source_time,
         slot, schema_version, payload, payload_hash, record_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
       ON CONFLICT (source, source_id, payload_hash) DO NOTHING`,
      [
        record.raw.observationId,
        record.raw.ingestionId,
        record.raw.source,
        record.raw.sourceId,
        record.raw.observedAt,
        record.raw.sourceTime,
        record.raw.slot ?? null,
        Number(record.raw.schemaVersion),
        JSON.stringify(record.raw.payload),
        record.raw.payloadHash,
        rawRecordHash,
      ],
    );
    await transaction.query(
      `INSERT INTO discovered_assets
        (chain, mint, symbol, category, market_cap_tier, first_observed_at, last_observed_at,
         research_role)
       VALUES ('solana',$1,$2,$3,$4,$5,$5,$6)
       ON CONFLICT (chain, mint) DO UPDATE SET
         symbol = COALESCE(EXCLUDED.symbol, discovered_assets.symbol),
         category = COALESCE(EXCLUDED.category, discovered_assets.category),
         market_cap_tier = COALESCE(EXCLUDED.market_cap_tier, discovered_assets.market_cap_tier),
         research_role = EXCLUDED.research_role,
         last_observed_at = GREATEST(discovered_assets.last_observed_at, EXCLUDED.last_observed_at)`,
      [
        record.market.configuredMint,
        record.market.configuredSymbol,
        record.market.category,
        record.market.marketCapTier,
        record.capturedAt,
        record.market.researchRole,
      ],
    );
    if (!record.normalized.poolId) throw new Error("DEX observation requires a pool identity");
    await transaction.query(
      `INSERT INTO discovered_pools
        (pool_id, chain, dex_id, pair_address, base_mint, quote_mint, first_observed_at)
       VALUES ($1,'solana',$2,$3,$4,$5,$6)
       ON CONFLICT (chain, dex_id, pair_address) DO NOTHING`,
      [
        record.normalized.poolId,
        record.market.dexId,
        record.market.pairAddress,
        record.market.baseMint,
        record.market.quoteMint,
        record.capturedAt,
      ],
    );
    await transaction.query(
      `INSERT INTO dex_market_observations
        (record_hash, observation_id, raw_record_hash, configured_mint, pool_id, observed_at,
         price, volume_24h, liquidity_usd, market_cap, fdv,
         price_change_5m, price_change_1h, price_change_6h, price_change_24h,
         buys_5m, sells_5m, buys_1h, sells_1h, buys_6h, sells_6h,
         buys_24h, sells_24h, pair_created_at, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       ON CONFLICT (record_hash) DO NOTHING`,
      [
        record.recordHash,
        record.raw.observationId,
        rawRecordHash,
        record.market.configuredMint,
        record.normalized.poolId,
        record.capturedAt,
        record.normalized.price,
        record.market.volume24h,
        record.normalized.liquidity,
        record.market.marketCap,
        record.market.fdv,
        record.market.priceChange5m,
        record.market.priceChange1h,
        record.market.priceChange6h,
        record.market.priceChange24h,
        record.market.buys5m,
        record.market.sells5m,
        record.market.buys1h,
        record.market.sells1h,
        record.market.buys6h,
        record.market.sells6h,
        record.market.buys24h,
        record.market.sells24h,
        record.market.pairCreatedAt,
        record.raw.source,
      ],
    );
  }

  public async health(): Promise<{
    readonly assets: number;
    readonly pools: number;
    readonly observations: number;
    readonly collectionErrors: number;
    readonly featureSnapshots: number;
    readonly forwardOutcomes: number;
    readonly routeAssessments: number;
    readonly integrityAssessments: number;
    readonly shadowDecisions: number;
    readonly paperPositions: number;
    readonly lastObservationAt: string | null;
  }> {
    const result = await this.#database.query<{
      assets: number;
      pools: number;
      observations: number;
      collection_errors: number;
      feature_snapshots: number;
      forward_outcomes: number;
      route_assessments: number;
      integrity_assessments: number;
      shadow_decisions: number;
      paper_positions: number;
      last_observation_at: Date | string | null;
    }>(`SELECT
      (SELECT count(*)::int FROM discovered_assets) AS assets,
      (SELECT count(*)::int FROM discovered_pools) AS pools,
      (SELECT count(*)::int FROM dex_market_observations) AS observations,
      (SELECT count(*)::int FROM collection_errors) AS collection_errors,
      (SELECT count(*)::int FROM market_feature_snapshots) AS feature_snapshots,
      (SELECT count(*)::int FROM forward_outcomes) AS forward_outcomes,
      (SELECT count(*)::int FROM route_sellability_assessments) AS route_assessments,
      (SELECT count(*)::int FROM token_market_integrity_assessments) AS integrity_assessments,
      (SELECT count(*)::int FROM shadow_decisions) AS shadow_decisions,
      (SELECT count(*)::int FROM paper_positions) AS paper_positions,
      (SELECT max(observed_at) FROM dex_market_observations) AS last_observation_at`);
    const row = result.rows[0];
    if (!row) throw new Error("database health query returned no rows");
    const last = row.last_observation_at;
    return {
      assets: row.assets,
      pools: row.pools,
      observations: row.observations,
      collectionErrors: row.collection_errors,
      featureSnapshots: row.feature_snapshots,
      forwardOutcomes: row.forward_outcomes,
      routeAssessments: row.route_assessments,
      integrityAssessments: row.integrity_assessments,
      shadowDecisions: row.shadow_decisions,
      paperPositions: row.paper_positions,
      lastObservationAt: last instanceof Date ? last.toISOString() : last,
    };
  }

  public async computeAndPersistFeatures(): Promise<number> {
    const result = await this.#database.query<{
      record_hash: `sha256:${string}`;
      pool_id: string;
      configured_mint: string;
      observed_at: Date | string;
      price: string;
      volume_24h: string | null;
      liquidity_usd: string;
      market_cap: string | null;
      fdv: string | null;
      buys_24h: number | null;
      sells_24h: number | null;
    }>(`SELECT record_hash, pool_id, configured_mint, observed_at, price::text,
              volume_24h::text, liquidity_usd::text, market_cap::text, fdv::text,
              buys_24h, sells_24h
       FROM dex_market_observations
       WHERE price > 0
       ORDER BY pool_id, observed_at, record_hash`);
    const histories = new Map<string, MarketPoint[]>();
    let inserted = 0;
    for (const row of result.rows) {
      const observedAt =
        row.observed_at instanceof Date ? row.observed_at.toISOString() : row.observed_at;
      const history = histories.get(row.pool_id) ?? [];
      history.push({
        recordHash: row.record_hash,
        observedAt,
        price: row.price,
        volume24h: row.volume_24h,
        liquidityUsd: row.liquidity_usd,
        marketCap: row.market_cap,
        fdv: row.fdv,
        buys24h: row.buys_24h,
        sells24h: row.sells_24h,
      });
      histories.set(row.pool_id, history);
      const features = computeMarketFeaturesV1(history, observedAt);
      const write = await this.#database.query(
        `INSERT INTO market_feature_snapshots
          (source_record_hash, pool_id, configured_mint, as_of, feature_version, values, content_hash)
         VALUES ($1,$2,$3,$4,1,$5::jsonb,$6)
         ON CONFLICT (source_record_hash, feature_version) DO NOTHING`,
        [
          row.record_hash,
          row.pool_id,
          row.configured_mint,
          observedAt,
          JSON.stringify(features.values),
          features.contentHash,
        ],
      );
      inserted += write.affectedRows ?? 0;
    }
    return inserted;
  }

  public async persistTokenSafety(
    assessedAt: string,
    results: readonly RpcMintAssessment[],
  ): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      for (const result of results) {
        await transaction.query(
          `INSERT INTO token_safety_assessments
            (mint, assessed_at, rpc_slot, assessment_version, status, reasons, facts, content_hash)
           VALUES ($1,$2,$3,1,$4,$5::jsonb,$6::jsonb,$7)
           ON CONFLICT (mint, assessed_at, assessment_version) DO NOTHING`,
          [
            result.mint,
            assessedAt,
            result.slot,
            result.assessment.status,
            JSON.stringify(result.assessment.reasons),
            JSON.stringify(result.assessment.facts),
            result.assessment.contentHash,
          ],
        );
      }
    });
  }

  public async persistRouteAssessments(
    assessedAt: string,
    results: readonly RouteAssessment[],
  ): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      for (const result of results) {
        await transaction.query(
          `INSERT INTO route_sellability_assessments
            (mint, assessed_at, provider, notional_usdc_atomic, buy_output_atomic,
             sell_output_usdc_atomic, round_trip_loss_bps, buy_price_impact_pct,
             sell_price_impact_pct, status, reason, raw_hash)
           VALUES ($1,$2,'jupiter-lite-quote-v1',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            result.mint,
            assessedAt,
            result.notionalUsdcAtomic,
            result.buyOutputAtomic,
            result.sellOutputUsdcAtomic,
            result.roundTripLossBps,
            result.buyPriceImpactPct,
            result.sellPriceImpactPct,
            result.status,
            result.reason,
            result.rawHash,
          ],
        );
      }
    });
  }

  public async persistMarketIntegrity(
    assessedAt: string,
    results: readonly MarketIntegrityAssessment[],
  ): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      for (const result of results) {
        await transaction.query(
          `INSERT INTO token_market_integrity_assessments
            (mint, assessed_at, provider, status, reasons, holder_count,
             top_holders_percentage, organic_score, organic_score_label, is_verified,
             is_suspicious, provider_updated_at, raw_hash)
           VALUES ($1,$2,'jupiter-tokens-v2',$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            result.mint,
            assessedAt,
            result.status,
            JSON.stringify(result.reasons),
            result.holderCount,
            result.topHoldersPercentage,
            result.organicScore,
            result.organicScoreLabel,
            result.isVerified,
            result.isSuspicious,
            result.providerUpdatedAt,
            result.rawHash,
          ],
        );
      }
    });
  }

  public async researchReport(): Promise<Record<string, unknown>> {
    const health = await this.health();
    const roles = await this.#database.query<{ research_role: string; count: number }>(
      `SELECT research_role, count(*)::int AS count FROM discovered_assets GROUP BY research_role ORDER BY research_role`,
    );
    const safety = await this.#database.query<{ status: string; count: number }>(
      `WITH latest AS (
         SELECT DISTINCT ON (mint) mint, status FROM token_safety_assessments
         ORDER BY mint, assessed_at DESC
       ) SELECT status, count(*)::int AS count FROM latest GROUP BY status ORDER BY status`,
    );
    const paper = await this.#database.query<{
      open: number;
      closed: number;
      wins: number;
      net_pnl: string;
      gross_profit: string;
      gross_loss: string;
    }>(`SELECT
      count(*) FILTER (WHERE status = 'OPEN')::int AS open,
      count(*) FILTER (WHERE status = 'CLOSED')::int AS closed,
      count(*) FILTER (WHERE status = 'CLOSED' AND net_pnl_usd > 0)::int AS wins,
      COALESCE(sum(net_pnl_usd) FILTER (WHERE status = 'CLOSED'), 0)::text AS net_pnl,
      COALESCE(sum(net_pnl_usd) FILTER (WHERE net_pnl_usd > 0), 0)::text AS gross_profit,
      COALESCE(abs(sum(net_pnl_usd) FILTER (WHERE net_pnl_usd < 0)), 0)::text AS gross_loss
      FROM paper_positions`);
    const decisions = await this.#database.query<{ decision: string; count: number }>(
      `SELECT decision, count(*)::int AS count FROM shadow_decisions GROUP BY decision ORDER BY decision`,
    );
    const collectionErrorCodes = await this.#database.query<{ error_code: string; count: number }>(
      `SELECT error_code, count(*)::int AS count FROM collection_errors
       GROUP BY error_code ORDER BY error_code`,
    );
    const openPaperPositions = await this.#database.query<{
      position_id: string;
      mint: string;
      strategy_version: string;
      opened_at: Date | string;
      entry_price: string;
      notional_usd: string;
      entry_cost_bps: number;
      current_price: string | null;
      current_observed_at: Date | string | null;
      safety_status: string | null;
      route_status: string | null;
      integrity_status: string | null;
    }>(`WITH market AS (
          SELECT DISTINCT ON (configured_mint) configured_mint AS mint, price, observed_at
          FROM dex_market_observations ORDER BY configured_mint, observed_at DESC, liquidity_usd DESC
        ), safety AS (
          SELECT DISTINCT ON (mint) mint, status FROM token_safety_assessments ORDER BY mint, assessed_at DESC
        ), route AS (
          SELECT DISTINCT ON (mint) mint, status FROM route_sellability_assessments ORDER BY mint, assessed_at DESC
        ), integrity AS (
          SELECT DISTINCT ON (mint) mint, status FROM token_market_integrity_assessments ORDER BY mint, assessed_at DESC
        )
        SELECT p.position_id, p.mint, p.strategy_version, p.opened_at, p.entry_price::text,
               p.notional_usd::text, p.entry_cost_bps, m.price::text AS current_price,
               m.observed_at AS current_observed_at, s.status AS safety_status,
               r.status AS route_status, i.status AS integrity_status
        FROM paper_positions p
        LEFT JOIN market m ON m.mint = p.mint
        LEFT JOIN safety s ON s.mint = p.mint
        LEFT JOIN route r ON r.mint = p.mint
        LEFT JOIN integrity i ON i.mint = p.mint
        WHERE p.status = 'OPEN' ORDER BY p.opened_at, p.position_id`);
    const candidates = await this.#database.query<{
      mint: string;
      symbol: string | null;
      category: string | null;
      observed_at: Date | string;
      liquidity_usd: string;
      volume_24h: string | null;
      market_cap: string | null;
      safety_status: string | null;
      safety_reasons: unknown;
      route_status: string | null;
      round_trip_loss_bps: string | null;
      route_assessed_at: Date | string | null;
      integrity_status: string | null;
      integrity_reasons: unknown;
      holder_count: number | null;
      top_holders_percentage: string | null;
      organic_score: string | null;
      integrity_assessed_at: Date | string | null;
      features: unknown;
    }>(`WITH latest_market AS (
          SELECT DISTINCT ON (configured_mint) configured_mint, observed_at, liquidity_usd,
                 volume_24h, market_cap, record_hash
          FROM dex_market_observations ORDER BY configured_mint, observed_at DESC, liquidity_usd DESC
        ), latest_safety AS (
          SELECT DISTINCT ON (mint) mint, status, reasons
          FROM token_safety_assessments ORDER BY mint, assessed_at DESC
        ), latest_route AS (
          SELECT DISTINCT ON (mint) mint, status, round_trip_loss_bps, assessed_at
          FROM route_sellability_assessments ORDER BY mint, assessed_at DESC
        ), latest_integrity AS (
          SELECT DISTINCT ON (mint) mint, status, reasons, holder_count,
                 top_holders_percentage, organic_score, assessed_at
          FROM token_market_integrity_assessments ORDER BY mint, assessed_at DESC
        )
        SELECT a.mint, a.symbol, a.category, m.observed_at, m.liquidity_usd::text,
               m.volume_24h::text, m.market_cap::text, s.status AS safety_status,
               s.reasons AS safety_reasons, r.status AS route_status,
               r.round_trip_loss_bps::text, r.assessed_at AS route_assessed_at,
               i.status AS integrity_status, i.reasons AS integrity_reasons, i.holder_count,
               i.top_holders_percentage::text, i.organic_score::text,
               i.assessed_at AS integrity_assessed_at, f.values AS features
        FROM discovered_assets a
        JOIN latest_market m ON m.configured_mint = a.mint
        LEFT JOIN latest_safety s ON s.mint = a.mint
        LEFT JOIN latest_route r ON r.mint = a.mint
        LEFT JOIN latest_integrity i ON i.mint = a.mint
        LEFT JOIN market_feature_snapshots f ON f.source_record_hash = m.record_hash AND f.feature_version = 1
        WHERE a.research_role = 'CANDIDATE'
        ORDER BY m.liquidity_usd DESC, a.mint`);
    const minimumLiquidity = new Decimal(50_000);
    const minimumVolume = new Decimal(1_000_000);
    const ranked = candidates.rows.map((row) => {
      const blockers: string[] = [];
      if (row.safety_status !== "PASS") blockers.push(`SAFETY_${row.safety_status ?? "MISSING"}`);
      if (row.route_status !== "PASS") blockers.push(`ROUTE_${row.route_status ?? "MISSING"}`);
      if (row.integrity_status !== "PASS")
        blockers.push(`INTEGRITY_${row.integrity_status ?? "MISSING"}`);
      if (
        row.route_assessed_at !== null &&
        Date.now() - new Date(row.route_assessed_at).getTime() > 45 * 60_000
      )
        blockers.push("ROUTE_STALE");
      if (
        row.integrity_assessed_at !== null &&
        Date.now() - new Date(row.integrity_assessed_at).getTime() > 45 * 60_000
      )
        blockers.push("INTEGRITY_STALE");
      if (new Decimal(row.liquidity_usd).lessThan(minimumLiquidity)) blockers.push("LOW_LIQUIDITY");
      if (row.volume_24h === null || new Decimal(row.volume_24h).lessThan(minimumVolume))
        blockers.push("LOW_VOLUME");
      return {
        mint: row.mint,
        symbol: row.symbol,
        category: row.category,
        observedAt:
          row.observed_at instanceof Date ? row.observed_at.toISOString() : row.observed_at,
        liquidityUsd: row.liquidity_usd,
        volume24h: row.volume_24h,
        marketCap: row.market_cap,
        safetyStatus: row.safety_status,
        safetyReasons: row.safety_reasons,
        routeStatus: row.route_status,
        roundTripLossBps: row.round_trip_loss_bps,
        routeAssessedAt:
          row.route_assessed_at instanceof Date
            ? row.route_assessed_at.toISOString()
            : row.route_assessed_at,
        integrityStatus: row.integrity_status,
        integrityReasons: row.integrity_reasons,
        holderCount: row.holder_count,
        topHoldersPercentage: row.top_holders_percentage,
        organicScore: row.organic_score,
        integrityAssessedAt:
          row.integrity_assessed_at instanceof Date
            ? row.integrity_assessed_at.toISOString()
            : row.integrity_assessed_at,
        features: row.features,
        decision: blockers.length === 0 ? "RESEARCH_ELIGIBLE" : "EXCLUDED",
        blockers,
      };
    });
    const categoryBreakdown = new Map<string, { total: number; researchEligible: number }>();
    for (const row of ranked) {
      const category = row.category ?? "unknown";
      const current = categoryBreakdown.get(category) ?? { total: 0, researchEligible: 0 };
      current.total += 1;
      if (row.decision === "RESEARCH_ELIGIBLE") current.researchEligible += 1;
      categoryBreakdown.set(category, current);
    }
    const benchmark = await this.#database.query<{
      symbol: string | null;
      values: Record<string, unknown>;
    }>(
      `SELECT a.symbol, f.values FROM discovered_assets a
       JOIN dex_market_observations m ON m.configured_mint = a.mint
       JOIN market_feature_snapshots f ON f.source_record_hash = m.record_hash AND f.feature_version = 1
       WHERE a.research_role = 'BENCHMARK'
       ORDER BY m.observed_at DESC, m.liquidity_usd DESC LIMIT 1`,
    );
    const benchmarkRow = benchmark.rows[0];
    const benchmarkReturn1h =
      typeof benchmarkRow?.values.return1hPct === "string"
        ? new Decimal(benchmarkRow.values.return1hPct)
        : null;
    const regime =
      benchmarkReturn1h === null
        ? "UNKNOWN"
        : benchmarkReturn1h.greaterThan(1)
          ? "RISK_ON"
          : benchmarkReturn1h.lessThan(-1)
            ? "RISK_OFF"
            : "NEUTRAL";
    return {
      generatedAt: new Date().toISOString(),
      mode: "RESEARCH_ONLY",
      health,
      roles: Object.fromEntries(roles.rows.map((row) => [row.research_role, row.count])),
      latestSafety: Object.fromEntries(safety.rows.map((row) => [row.status, row.count])),
      collectionErrorCodes: Object.fromEntries(
        collectionErrorCodes.rows.map((row) => [row.error_code, row.count]),
      ),
      shadowDecisions: Object.fromEntries(decisions.rows.map((row) => [row.decision, row.count])),
      paperPortfolio: paper.rows[0],
      openPaperPositions: openPaperPositions.rows.map((row) => ({
        positionId: row.position_id,
        mint: row.mint,
        strategyVersion: row.strategy_version,
        openedAt: row.opened_at instanceof Date ? row.opened_at.toISOString() : row.opened_at,
        entryPrice: row.entry_price,
        notionalUsd: row.notional_usd,
        entryCostBps: row.entry_cost_bps,
        currentPrice: row.current_price,
        currentObservedAt:
          row.current_observed_at instanceof Date
            ? row.current_observed_at.toISOString()
            : row.current_observed_at,
        estimatedNetPnlUsd:
          row.current_price === null
            ? null
            : new Decimal(row.notional_usd)
                .mul(10_000 - row.entry_cost_bps)
                .div(10_000)
                .div(row.entry_price)
                .mul(row.current_price)
                .mul(10_000 - 100)
                .div(10_000)
                .minus(row.notional_usd)
                .toString(),
        currentGates: {
          safety: row.safety_status,
          route: row.route_status,
          integrity: row.integrity_status,
        },
        entryPolicyStillPasses:
          row.safety_status === "PASS" &&
          row.route_status === "PASS" &&
          row.integrity_status === "PASS",
      })),
      researchEligible: ranked.filter((row) => row.decision === "RESEARCH_ELIGIBLE").length,
      categoryBreakdown: Object.fromEntries([...categoryBreakdown.entries()].sort()),
      marketRegime: {
        status: regime,
        benchmark: benchmarkRow?.symbol ?? null,
        benchmarkReturn1hPct: benchmarkReturn1h?.toString() ?? null,
        rule: "RISK_ON above +1%, RISK_OFF below -1%, otherwise NEUTRAL; UNKNOWN without 1h history",
      },
      candidates: ranked,
      caveats: [
        "Eligibility is a data and safety gate, not a buy signal.",
        "No strategy is validated until forward outcomes and walk-forward samples mature.",
        "No wallet, signing, submission, or live execution capability exists.",
      ],
    };
  }

  public async runPaperStyleLabCycle(
    asOf = new Date().toISOString(),
  ): Promise<Record<string, unknown>> {
    const evaluatedAt = toIsoTimestamp(asOf);
    const rows = await this.#database.query<{
      source_time: Date | string;
      price: string;
      quality_score: string;
      uncertainty_bps: string | null;
      exit_price: string | null;
      regime: MarketRegime | null;
      regime_sample_size: number | null;
      protocol_flow_zscore: string | null;
      capital_flow_episode_count: number;
    }>(
      `SELECT p.as_of AS source_time, p.price::text, p.quality_score::text,
              p.uncertainty_bps::text,
              (SELECT future.price::text FROM reference_price_snapshots future
               WHERE future.base_asset = p.base_asset AND future.status = 'PUBLISHED'
                 AND future.as_of >= p.as_of + interval '5 minutes'
                 AND future.as_of <= $1
               ORDER BY future.as_of, future.snapshot_id LIMIT 1) AS exit_price,
              (SELECT regime.state FROM market_regime_snapshots regime
               WHERE regime.as_of <= p.as_of
               ORDER BY regime.as_of DESC, regime.regime_id DESC LIMIT 1) AS regime,
              (SELECT regime.sample_size FROM market_regime_snapshots regime
               WHERE regime.as_of <= p.as_of
               ORDER BY regime.as_of DESC, regime.regime_id DESC LIMIT 1) AS regime_sample_size
              ,(SELECT flow.event_count_zscore::text FROM protocol_flow_windows flow
                WHERE flow.window_start <= p.as_of
                  AND flow.window_start > p.as_of - interval '1 hour'
                ORDER BY flow.window_start DESC, flow.feature_id DESC LIMIT 1) AS protocol_flow_zscore
              ,(SELECT count(*)::int FROM capital_flow_episodes episode
                WHERE episode.window_start <= p.as_of
                  AND episode.window_start > p.as_of - interval '1 hour') AS capital_flow_episode_count
       FROM reference_price_snapshots p
       WHERE p.base_asset = 'SOL' AND p.status = 'PUBLISHED' AND p.as_of <= $1
       ORDER BY p.as_of DESC, p.snapshot_id DESC LIMIT 5000`,
      [evaluatedAt],
    );
    const chronological = [...rows.rows].reverse();
    const observations: StyleTrainingObservation[] = [];
    const rollingPrices: Decimal[] = [];
    for (const row of chronological) {
      const price = new Decimal(row.price);
      rollingPrices.push(price);
      if (rollingPrices.length > 60) rollingPrices.shift();
      if (row.exit_price === null || row.regime === null || rollingPrices.length < 3) continue;
      const mean = rollingPrices
        .reduce((sum, value) => sum.plus(value), new Decimal(0))
        .div(rollingPrices.length);
      observations.push({
        sourceTime: toIsoTimestamp(row.source_time),
        regime: row.regime,
        regimeConfidence: Math.min(1, Math.max(0, (row.regime_sample_size ?? 0) / 60)),
        liquidityScore: Number(row.quality_score),
        spreadBps: Number(row.uncertainty_bps ?? 10_000),
        deviationFromMeanBps: price.minus(mean).div(mean).mul(10_000).toNumber(),
        forwardReturnBps: new Decimal(row.exit_price)
          .minus(price)
          .div(price)
          .mul(10_000)
          .toNumber(),
        protocolFlowZScore:
          row.protocol_flow_zscore === null ? null : Number(row.protocol_flow_zscore),
        capitalFlowEpisodeCount: row.capital_flow_episode_count,
      });
    }
    const validated = referenceStyleLibrary.map((definition) => ({
      definition,
      validation: validateReferenceStyleWalkForward({
        definition,
        observations,
        roundTripCostBps: 100,
        minimumDevelopmentObservations: 500,
        evaluationWindowObservations: 250,
        minimumEvaluationTrades: 100,
        minimumPositiveFoldFraction: 0.67,
      }),
    }));
    const flowCoverage = {
      observationCount: observations.length,
      protocolFlowObservationCount: observations.filter(
        (observation) => observation.protocolFlowZScore !== null,
      ).length,
      capitalFlowObservationCount: observations.filter(
        (observation) => observation.capitalFlowEpisodeCount > 0,
      ).length,
    };
    const trained = validated.map(({ definition, validation }) =>
      trainReferenceStyle({
        definition,
        observations,
        roundTripCostBps: 100,
        minimumSampleSize: 100,
        validationVerdict: validation.verdict,
      }),
    );
    for (const [index, result] of trained.entries()) {
      const validation = validated.at(index)?.validation;
      const body = {
        profile: result.profile,
        tradeCount: result.tradeCount,
        winRate: result.winRate,
        cumulativeNetReturnBps: result.cumulativeNetReturnBps,
        validationVerdict: result.validationVerdict,
        validation,
        flowCoverage,
      };
      const hash = contentHash(body);
      await this.#database.query(
        `INSERT INTO paper_style_profiles
          (profile_id, style_id, style_version, trained_at, status, validation_verdict,
           profile, metrics, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)
         ON CONFLICT (content_hash) DO NOTHING`,
        [
          deterministicDomainId("paper_style_profile", hash),
          result.profile.styleId,
          result.profile.version,
          evaluatedAt,
          result.profile.status,
          result.validationVerdict,
          JSON.stringify(result.profile),
          JSON.stringify({
            tradeCount: result.tradeCount,
            winRate: result.winRate,
            cumulativeNetReturnBps: result.cumulativeNetReturnBps,
            validation,
            flowCoverage,
          }),
          hash,
        ],
      );
    }
    const latest = observations.at(-1);
    const marketState = latest
      ? {
          asOf: evaluatedAt,
          regime: latest.regime,
          regimeConfidence: latest.regimeConfidence,
          liquidityScore: latest.liquidityScore,
          spreadBps: latest.spreadBps,
        }
      : {
          asOf: evaluatedAt,
          regime: "INSUFFICIENT_DATA" as const,
          regimeConfidence: 0,
          liquidityScore: 0,
          spreadBps: 10_000,
        };
    const policy = {
      policyVersion: "paper-style-selector-v1",
      minimumDecisionScoreBps: 2,
      drawdownPenalty: 0.05,
    };
    const decision = selectPaperStyle({
      marketState,
      profiles: trained.map((result) => result.profile),
      policy,
    });
    const decisionBody = { decision, marketState };
    const decisionHash = contentHash(decisionBody);
    const decisionId = deterministicDomainId("paper_style_decision", decisionHash);
    await this.#database.query(
      `INSERT INTO paper_style_selections
        (decision_id, as_of, mode, policy_version, decision, selected_style_id,
         selected_style_version, score_bps, reasons, market_state, candidates, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12)
       ON CONFLICT (content_hash) DO NOTHING`,
      [
        decisionId,
        decision.asOf,
        decision.mode,
        decision.policyVersion,
        decision.decision,
        decision.selectedStyleId,
        decision.selectedStyleVersion,
        decision.scoreBps,
        JSON.stringify(decision.reasons),
        JSON.stringify(marketState),
        JSON.stringify(decision.candidates),
        decisionHash,
      ],
    );
    const currentPriceRow = chronological.at(-1);
    const lifecycle = currentPriceRow
      ? await this.advancePaperStylePortfolio({
          evaluatedAt,
          marketObservedAt: toIsoTimestamp(currentPriceRow.source_time),
          priceUsd: currentPriceRow.price,
          spreadBps: Number(currentPriceRow.uncertainty_bps ?? 10_000),
          decisionId,
          decision,
        })
      : { exits: 0, entry: "NO_MARKET_PRICE" as const };
    return {
      authority: "READ_ONLY_PAPER_LAB",
      mode: "PAPER_ONLY",
      asOf: evaluatedAt,
      trainingObservationCount: observations.length,
      styles: trained,
      decision,
      lifecycle,
    };
  }

  private async advancePaperStylePortfolio(input: {
    readonly evaluatedAt: string;
    readonly marketObservedAt: string;
    readonly priceUsd: string;
    readonly spreadBps: number;
    readonly decisionId: string;
    readonly decision: ReturnType<typeof selectPaperStyle>;
  }): Promise<Record<string, unknown>> {
    const portfolioId = "cfie-paper-style-portfolio-v1";
    const latestPortfolio = await this.#database.query<{
      snapshot_id: string;
      portfolio_version: number;
      balances_atomic: Record<string, string>;
    }>(
      `SELECT snapshot_id, portfolio_version, balances_atomic
       FROM paper_portfolio_snapshots WHERE portfolio_id = $1
       ORDER BY portfolio_version DESC LIMIT 1`,
      [portfolioId],
    );
    let portfolio: PaperPortfolio = latestPortfolio.rows[0]
      ? {
          portfolioId,
          version: latestPortfolio.rows[0].portfolio_version,
          balancesAtomic: latestPortfolio.rows[0].balances_atomic,
        }
      : { portfolioId, version: 0, balancesAtomic: { USDC: "1000000000", SOL: "0" } };
    const persistSnapshot = async (): Promise<string> => {
      const body = { portfolio, observedAt: input.evaluatedAt };
      const hash = contentHash(body);
      const snapshotId = deterministicDomainId("paper_portfolio_snapshot", hash);
      await this.#database.query(
        `INSERT INTO paper_portfolio_snapshots
          (snapshot_id, portfolio_id, portfolio_version, observed_at, balances_atomic, content_hash)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (content_hash) DO NOTHING`,
        [
          snapshotId,
          portfolio.portfolioId,
          portfolio.version,
          input.evaluatedAt,
          JSON.stringify(portfolio.balancesAtomic),
          hash,
        ],
      );
      return snapshotId;
    };

    const openPositions = await this.#database.query<{
      position_id: string;
      observed_at: Date | string;
      style_id: string;
      style_version: string;
      quantity_atomic: string;
      notional_usd: string;
    }>(`SELECT opened.position_id, opened.observed_at, opened.style_id, opened.style_version,
              opened.quantity_atomic::text, opened.notional_usd::text
       FROM paper_style_position_events opened
       WHERE opened.event_type = 'OPEN' AND NOT EXISTS (
         SELECT 1 FROM paper_style_position_events closed
         WHERE closed.position_id = opened.position_id AND closed.event_type = 'CLOSE'
       ) ORDER BY opened.observed_at, opened.position_id`);
    let exits = 0;
    for (const position of openPositions.rows) {
      if (
        new Date(input.evaluatedAt).getTime() - new Date(position.observed_at).getTime() <
        60 * 60_000
      )
        continue;
      const exitIntentId = deterministicDomainId(
        "paper_exit_intent",
        `${position.position_id}:${input.evaluatedAt}`,
      );
      const verdict = {
        mode: "PAPER_ONLY" as const,
        policyVersion: "paper-risk-v1",
        intentId: exitIntentId,
        styleId: position.style_id,
        outcome: "APPROVED_FOR_PAPER_FILL" as const,
        checks: [{ check: "EXIT_REDUCES_EXPOSURE", outcome: "PASS", actual: 1, threshold: 1 }],
      };
      const verdictHash = contentHash(verdict);
      const verdictId = deterministicDomainId("paper_risk_verdict", verdictHash);
      await this.#database.query(
        `INSERT INTO paper_risk_verdicts
          (verdict_id, decision_id, evaluated_at, mode, outcome, verdict, content_hash)
         VALUES ($1,$2,$3,'PAPER_ONLY',$4,$5::jsonb,$6)
         ON CONFLICT (content_hash) DO NOTHING`,
        [
          verdictId,
          input.decisionId,
          input.evaluatedAt,
          verdict.outcome,
          JSON.stringify(verdict),
          verdictHash,
        ],
      );
      const grossUsdcAtomic = new Decimal(position.quantity_atomic)
        .div(1_000_000_000)
        .mul(input.priceUsd)
        .mul(1_000_000)
        .floor();
      const orderId = deterministicDomainId("paper_exit_order", exitIntentId);
      const fill = simulatePaperFill(
        {
          orderId,
          inputAtomic: position.quantity_atomic,
          quotedOutputAtomic: Decimal.max(0, grossUsdcAtomic).toFixed(0),
          availableLiquidityInputAtomic: position.quantity_atomic,
          priceImpactBps: Math.max(1, Math.ceil(input.spreadBps)),
          slippageBps: 20,
          decidedAt: input.evaluatedAt,
          quoteExpiresAt: new Date(new Date(input.evaluatedAt).getTime() + 60_000).toISOString(),
          deterministicFailureDrawBps: 9_999,
        },
        {
          modelVersion: "cfie-paper-fill-v1",
          decisionToQuoteLatencyMs: 250,
          quoteToSubmitLatencyMs: 250,
          routeFeeBps: 30,
          networkFeeAtomic: "0",
          baseFailureBps: 10,
          stressMultiplier: "1.25",
        },
      );
      if (fill.status === "REJECTED") continue;
      const applied = applyPaperFill({ portfolio, inputAsset: "SOL", outputAsset: "USDC", fill });
      if (applied.status !== "APPLIED") continue;
      portfolio = applied.portfolio;
      const exitSnapshotId = await persistSnapshot();
      const fillHash = contentHash({ fill, decisionId: input.decisionId, verdictId });
      const fillId = deterministicDomainId("paper_fill", fillHash);
      await this.#database.query(
        `INSERT INTO paper_fill_events
          (fill_id, decision_id, verdict_id, portfolio_snapshot_id, observed_at, status, fill, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT (content_hash) DO NOTHING`,
        [
          fillId,
          input.decisionId,
          verdictId,
          exitSnapshotId,
          input.evaluatedAt,
          fill.status,
          JSON.stringify(fill),
          fillHash,
        ],
      );
      const proceedsUsd = new Decimal(fill.outputAtomic).div(1_000_000);
      const realizedPnlUsd = proceedsUsd.minus(position.notional_usd);
      const eventBody = {
        positionId: position.position_id,
        eventType: "CLOSE",
        fillId,
        realizedPnlUsd: realizedPnlUsd.toString(),
      };
      const eventHash = contentHash(eventBody);
      await this.#database.query(
        `INSERT INTO paper_style_position_events
          (event_id, position_id, decision_id, fill_id, event_type, observed_at, style_id,
           style_version, price_usd, quantity_atomic, notional_usd, realized_pnl_usd, content_hash)
         VALUES ($1,$2,$3,$4,'CLOSE',$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (content_hash) DO NOTHING`,
        [
          deterministicDomainId("paper_position_event", eventHash),
          position.position_id,
          input.decisionId,
          fillId,
          input.evaluatedAt,
          position.style_id,
          position.style_version,
          input.priceUsd,
          position.quantity_atomic,
          position.notional_usd,
          realizedPnlUsd.toString(),
          eventHash,
        ],
      );
      exits += 1;
    }

    if (input.decision.decision !== "SELECT_STYLE") return { exits, entry: "NO_TRADE" };
    const selectedStyleId = input.decision.selectedStyleId;
    const selectedStyleVersion = input.decision.selectedStyleVersion;
    if (selectedStyleId === null || selectedStyleVersion === null)
      throw new Error("selected paper style identity is missing");
    const stillOpen = await this.#database.query<{ exposure_usd: string; count: number }>(
      `SELECT COALESCE(sum(opened.notional_usd),0)::text AS exposure_usd, count(*)::int AS count
       FROM paper_style_position_events opened
       WHERE opened.event_type = 'OPEN' AND NOT EXISTS (
         SELECT 1 FROM paper_style_position_events closed
         WHERE closed.position_id = opened.position_id AND closed.event_type = 'CLOSE')`,
    );
    const daily = await this.#database.query<{ pnl: string }>(
      `SELECT COALESCE(sum(realized_pnl_usd),0)::text AS pnl FROM paper_style_position_events
       WHERE event_type = 'CLOSE' AND observed_at >= date_trunc('day',$1::timestamptz)`,
      [input.evaluatedAt],
    );
    const dailyPnl = Number(daily.rows[0]?.pnl ?? 0);
    const risk = evaluatePaperRisk({
      limits: {
        policyVersion: "paper-risk-v1",
        maximumTradeNotionalUsd: 100,
        maximumAssetExposureUsd: 100,
        maximumPortfolioDrawdownPct: 5,
        maximumDailyLossUsd: 50,
        maximumMarketDataAgeSeconds: 900,
      },
      snapshot: {
        evaluatedAt: input.evaluatedAt,
        marketDataAgeSeconds: Math.max(
          0,
          (new Date(input.evaluatedAt).getTime() - new Date(input.marketObservedAt).getTime()) /
            1000,
        ),
        portfolioDrawdownPct: Math.max(0, (-dailyPnl / 1000) * 100),
        dailyPnlUsd: dailyPnl,
        currentAssetExposureUsd: Number(stillOpen.rows[0]?.exposure_usd ?? 0),
      },
      intent: {
        intentId: deterministicDomainId("paper_entry_intent", input.decisionId),
        styleId: selectedStyleId,
        tradeNotionalUsd: 100,
      },
    });
    const verdictHash = contentHash(risk);
    const verdictId = deterministicDomainId("paper_risk_verdict", verdictHash);
    await this.#database.query(
      `INSERT INTO paper_risk_verdicts
        (verdict_id, decision_id, evaluated_at, mode, outcome, verdict, content_hash)
       VALUES ($1,$2,$3,'PAPER_ONLY',$4,$5::jsonb,$6) ON CONFLICT (content_hash) DO NOTHING`,
      [
        verdictId,
        input.decisionId,
        input.evaluatedAt,
        risk.outcome,
        JSON.stringify(risk),
        verdictHash,
      ],
    );
    if (risk.outcome !== "APPROVED_FOR_PAPER_FILL") return { exits, entry: "RISK_REJECTED", risk };
    const inputAtomic = "100000000";
    const grossSolAtomic = new Decimal(100).div(input.priceUsd).mul(1_000_000_000).floor();
    const orderId = deterministicDomainId("paper_entry_order", input.decisionId);
    const draw = Number.parseInt(contentHash(orderId).slice(-4), 16) % 10_000;
    const fill = simulatePaperFill(
      {
        orderId,
        inputAtomic,
        quotedOutputAtomic: Decimal.max(0, grossSolAtomic).toFixed(0),
        availableLiquidityInputAtomic: inputAtomic,
        priceImpactBps: Math.max(1, Math.ceil(input.spreadBps)),
        slippageBps: 20,
        decidedAt: input.evaluatedAt,
        quoteExpiresAt: new Date(new Date(input.evaluatedAt).getTime() + 60_000).toISOString(),
        deterministicFailureDrawBps: draw,
      },
      {
        modelVersion: "cfie-paper-fill-v1",
        decisionToQuoteLatencyMs: 250,
        quoteToSubmitLatencyMs: 250,
        routeFeeBps: 30,
        networkFeeAtomic: "5000",
        baseFailureBps: 10,
        stressMultiplier: "1.25",
      },
    );
    if (fill.status === "REJECTED") return { exits, entry: fill.reason, risk, fill };
    const applied = applyPaperFill({ portfolio, inputAsset: "USDC", outputAsset: "SOL", fill });
    if (applied.status !== "APPLIED") return { exits, entry: applied.reason, risk, fill };
    portfolio = applied.portfolio;
    const entrySnapshotId = await persistSnapshot();
    const fillHash = contentHash({ fill, decisionId: input.decisionId, verdictId });
    const fillId = deterministicDomainId("paper_fill", fillHash);
    await this.#database.query(
      `INSERT INTO paper_fill_events
        (fill_id, decision_id, verdict_id, portfolio_snapshot_id, observed_at, status, fill, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT (content_hash) DO NOTHING`,
      [
        fillId,
        input.decisionId,
        verdictId,
        entrySnapshotId,
        input.evaluatedAt,
        fill.status,
        JSON.stringify(fill),
        fillHash,
      ],
    );
    const positionId = deterministicDomainId("paper_style_position", input.decisionId);
    const eventBody = { positionId, eventType: "OPEN", fillId };
    const eventHash = contentHash(eventBody);
    await this.#database.query(
      `INSERT INTO paper_style_position_events
        (event_id, position_id, decision_id, fill_id, event_type, observed_at, style_id,
         style_version, price_usd, quantity_atomic, notional_usd, realized_pnl_usd, content_hash)
       VALUES ($1,$2,$3,$4,'OPEN',$5,$6,$7,$8,$9,100,NULL,$10)
       ON CONFLICT (content_hash) DO NOTHING`,
      [
        deterministicDomainId("paper_position_event", eventHash),
        positionId,
        input.decisionId,
        fillId,
        input.evaluatedAt,
        selectedStyleId,
        selectedStyleVersion,
        input.priceUsd,
        fill.outputAtomic,
        eventHash,
      ],
    );
    return { exits, entry: "OPENED", risk, fill, portfolioVersion: portfolio.version };
  }

  public async paperStyleLabReport(): Promise<Record<string, unknown>> {
    const counts = await this.#database.query<{
      profiles: number;
      selections: number;
      risk_verdicts: number;
      fills: number;
      portfolios: number;
      open_positions: number;
      closed_positions: number;
    }>(`SELECT
      (SELECT count(*)::int FROM paper_style_profiles) AS profiles,
      (SELECT count(*)::int FROM paper_style_selections) AS selections,
      (SELECT count(*)::int FROM paper_risk_verdicts) AS risk_verdicts,
      (SELECT count(*)::int FROM paper_fill_events) AS fills,
      (SELECT count(*)::int FROM paper_portfolio_snapshots) AS portfolios,
      (SELECT count(*)::int FROM paper_style_position_events opened
       WHERE opened.event_type = 'OPEN' AND NOT EXISTS (
         SELECT 1 FROM paper_style_position_events closed
         WHERE closed.position_id = opened.position_id AND closed.event_type = 'CLOSE')) AS open_positions,
      (SELECT count(*)::int FROM paper_style_position_events WHERE event_type = 'CLOSE') AS closed_positions`);
    const latestSelection = await this.#database.query<{
      decision_id: string;
      as_of: Date | string;
      decision: string;
      selected_style_id: string | null;
      selected_style_version: string | null;
      score_bps: string | null;
      reasons: unknown;
      market_state: unknown;
      candidates: unknown;
    }>(`SELECT decision_id, as_of, decision, selected_style_id, selected_style_version,
              score_bps::text, reasons, market_state, candidates
       FROM paper_style_selections ORDER BY as_of DESC, decision_id DESC LIMIT 1`);
    const latestProfiles = await this.#database.query<{
      style_id: string;
      style_version: string;
      trained_at: Date | string;
      status: string;
      validation_verdict: string;
      profile: unknown;
      metrics: unknown;
    }>(`SELECT DISTINCT ON (style_id) style_id, style_version, trained_at, status,
              validation_verdict, profile, metrics
       FROM paper_style_profiles ORDER BY style_id, trained_at DESC, profile_id DESC`);
    const selection = latestSelection.rows[0];
    return {
      authority: "READ_ONLY_PAPER_LAB",
      mode: "PAPER_ONLY",
      counts: counts.rows[0] ?? {
        profiles: 0,
        selections: 0,
        risk_verdicts: 0,
        fills: 0,
        portfolios: 0,
        open_positions: 0,
        closed_positions: 0,
      },
      latestSelection: selection ? { ...selection, as_of: toIsoTimestamp(selection.as_of) } : null,
      latestProfiles: latestProfiles.rows.map((profile) => ({
        ...profile,
        trained_at: toIsoTimestamp(profile.trained_at),
      })),
      invariants: {
        walletAccess: false,
        signing: false,
        transactionSubmission: false,
        exchangeTrading: false,
        capitalAllocation: false,
      },
    };
  }

  public async runShadowCycle(asOf = new Date().toISOString()): Promise<Record<string, unknown>> {
    const strategyVersion = "MOMENTUM_SAFETY_V1";
    const costBps = 100;
    const notionalUsd = new Decimal(100);
    const repaired = await this.#database.query(
      `INSERT INTO paper_positions
        (position_id, mint, pool_id, strategy_version, status, opened_at, open_record_hash,
         entry_price, notional_usd, entry_cost_bps)
       SELECT 'id_paper_repair_' || substring(d.decision_id from 1 for 24), d.mint, m.pool_id,
              d.strategy_version, 'OPEN', m.observed_at, m.record_hash, m.price, $1, $2
       FROM shadow_decisions d
       JOIN dex_market_observations m ON m.record_hash = d.source_record_hash
       LEFT JOIN paper_positions p ON p.open_record_hash = d.source_record_hash
       WHERE d.decision = 'ENTER' AND p.position_id IS NULL
       ON CONFLICT DO NOTHING`,
      [notionalUsd.toString(), costBps],
    );
    let closed = 0;
    const openPositions = await this.#database.query<{
      position_id: string;
      mint: string;
      opened_at: Date | string;
      entry_price: string;
      notional_usd: string;
    }>(`SELECT position_id, mint, opened_at, entry_price::text, notional_usd::text
       FROM paper_positions WHERE status = 'OPEN'`);
    const openMints = new Set(openPositions.rows.map((position) => position.mint));
    for (const position of openPositions.rows) {
      const openedAt = toIsoTimestamp(position.opened_at);
      if (new Date(asOf).getTime() - new Date(openedAt).getTime() < 60 * 60_000) continue;
      const route = await this.#database.query<{ status: string; assessed_at: Date | string }>(
        `SELECT status, assessed_at FROM route_sellability_assessments
         WHERE mint = $1 ORDER BY assessed_at DESC LIMIT 1`,
        [position.mint],
      );
      const latestRoute = route.rows[0];
      if (latestRoute?.status !== "PASS") continue;
      if (new Date(asOf).getTime() - new Date(latestRoute.assessed_at).getTime() > 45 * 60_000)
        continue;
      const latest = await this.#database.query<{
        record_hash: string;
        observed_at: Date | string;
        price: string;
      }>(
        `SELECT record_hash, observed_at, price::text FROM dex_market_observations
         WHERE configured_mint = $1 AND observed_at > $2 AND price > 0
         ORDER BY observed_at DESC, liquidity_usd DESC LIMIT 1`,
        [position.mint, openedAt],
      );
      const exit = latest.rows[0];
      if (!exit) continue;
      const quantity = new Decimal(position.notional_usd)
        .mul(10_000 - costBps)
        .div(10_000)
        .div(position.entry_price);
      const proceeds = quantity
        .mul(exit.price)
        .mul(10_000 - costBps)
        .div(10_000);
      const pnl = proceeds.minus(position.notional_usd);
      const changed = await this.#database.query(
        `UPDATE paper_positions SET status = 'CLOSED', closed_at = $2, close_record_hash = $3,
           exit_price = $4, exit_cost_bps = $5, net_pnl_usd = $6
         WHERE position_id = $1 AND status = 'OPEN'`,
        [
          position.position_id,
          toIsoTimestamp(exit.observed_at),
          exit.record_hash,
          exit.price,
          costBps,
          pnl.toString(),
        ],
      );
      closed += changed.affectedRows ?? 0;
    }

    const latest = await this.#database.query<{
      record_hash: string;
      mint: string;
      pool_id: string;
      observed_at: Date | string;
      price: string;
      liquidity_usd: string;
      volume_24h: string | null;
      safety_status: string | null;
      route_status: string | null;
      route_assessed_at: Date | string | null;
      integrity_status: string | null;
      integrity_assessed_at: Date | string | null;
      values: Record<string, unknown>;
    }>(`WITH market AS (
          SELECT DISTINCT ON (configured_mint) record_hash, configured_mint AS mint, pool_id,
                 observed_at, price, liquidity_usd, volume_24h
          FROM dex_market_observations ORDER BY configured_mint, observed_at DESC, liquidity_usd DESC
        ), safety AS (
          SELECT DISTINCT ON (mint) mint, status FROM token_safety_assessments ORDER BY mint, assessed_at DESC
        ), route AS (
          SELECT DISTINCT ON (mint) mint, status, assessed_at FROM route_sellability_assessments
          ORDER BY mint, assessed_at DESC
        ), integrity AS (
          SELECT DISTINCT ON (mint) mint, status, assessed_at
          FROM token_market_integrity_assessments ORDER BY mint, assessed_at DESC
        )
        SELECT m.record_hash, m.mint, m.pool_id, m.observed_at, m.price::text,
               m.liquidity_usd::text, m.volume_24h::text, s.status AS safety_status,
               r.status AS route_status, r.assessed_at AS route_assessed_at,
               i.status AS integrity_status, i.assessed_at AS integrity_assessed_at, f.values
        FROM market m JOIN discovered_assets a ON a.mint = m.mint AND a.research_role = 'CANDIDATE'
        LEFT JOIN safety s ON s.mint = m.mint
        LEFT JOIN route r ON r.mint = m.mint
        LEFT JOIN integrity i ON i.mint = m.mint
        JOIN market_feature_snapshots f ON f.source_record_hash = m.record_hash AND f.feature_version = 1`);
    let entered = 0;
    let noTrade = 0;
    for (const row of latest.rows) {
      const return5m =
        typeof row.values.return5mPct === "string" ? new Decimal(row.values.return5mPct) : null;
      const buyShare =
        typeof row.values.buyShare24h === "string" ? new Decimal(row.values.buyShare24h) : null;
      const history =
        typeof row.values.historySpanSeconds === "string"
          ? new Decimal(row.values.historySpanSeconds)
          : new Decimal(0);
      const reasons: string[] = [];
      if (openMints.has(row.mint)) reasons.push("OPEN_POSITION_GATE");
      if (row.safety_status !== "PASS") reasons.push("SAFETY_GATE");
      if (row.route_status !== "PASS") reasons.push("ROUTE_GATE");
      if (row.integrity_status !== "PASS") reasons.push("MARKET_INTEGRITY_GATE");
      if (
        row.route_assessed_at === null ||
        new Date(asOf).getTime() - new Date(row.route_assessed_at).getTime() > 45 * 60_000
      )
        reasons.push("ROUTE_FRESHNESS_GATE");
      if (
        row.integrity_assessed_at === null ||
        new Date(asOf).getTime() - new Date(row.integrity_assessed_at).getTime() > 45 * 60_000
      )
        reasons.push("MARKET_INTEGRITY_FRESHNESS_GATE");
      if (new Decimal(row.liquidity_usd).lessThan(50_000)) reasons.push("LIQUIDITY_GATE");
      if (row.volume_24h === null || new Decimal(row.volume_24h).lessThan(1_000_000))
        reasons.push("VOLUME_GATE");
      if (history.lessThan(300)) reasons.push("INSUFFICIENT_HISTORY");
      if (return5m === null || return5m.lessThan(0.25)) reasons.push("MOMENTUM_GATE");
      if (buyShare === null || buyShare.lessThan(0.52)) reasons.push("BUY_PRESSURE_GATE");
      const decision = reasons.length === 0 ? "ENTER" : "NO_TRADE";
      const decisionId = deterministicDomainId(
        "shadow_decision",
        `${strategyVersion}:${row.record_hash}`,
      );
      if (decision === "NO_TRADE") {
        const write = await this.#database.query(
          `INSERT INTO shadow_decisions
            (decision_id, source_record_hash, mint, evaluated_at, strategy_version, decision, reasons, values)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
           ON CONFLICT (source_record_hash, strategy_version) DO NOTHING`,
          [
            decisionId,
            row.record_hash,
            row.mint,
            asOf,
            strategyVersion,
            decision,
            JSON.stringify(reasons),
            JSON.stringify(row.values),
          ],
        );
        noTrade += write.affectedRows ?? 0;
        continue;
      }
      const positionId = deterministicDomainId("paper_position", decisionId);
      const observedAt =
        row.observed_at instanceof Date ? row.observed_at.toISOString() : row.observed_at;
      entered += await this.#database.transaction(async (transaction) => {
        const write = await transaction.query(
          `INSERT INTO shadow_decisions
            (decision_id, source_record_hash, mint, evaluated_at, strategy_version, decision, reasons, values)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
           ON CONFLICT (source_record_hash, strategy_version) DO NOTHING`,
          [
            decisionId,
            row.record_hash,
            row.mint,
            asOf,
            strategyVersion,
            decision,
            JSON.stringify(reasons),
            JSON.stringify(row.values),
          ],
        );
        if ((write.affectedRows ?? 0) === 0) return 0;
        const opened = await transaction.query(
          `INSERT INTO paper_positions
            (position_id, mint, pool_id, strategy_version, status, opened_at, open_record_hash,
             entry_price, notional_usd, entry_cost_bps)
           VALUES ($1,$2,$3,$4,'OPEN',$5,$6,$7,$8,$9)`,
          [
            positionId,
            row.mint,
            row.pool_id,
            strategyVersion,
            observedAt,
            row.record_hash,
            row.price,
            notionalUsd.toString(),
            costBps,
          ],
        );
        return opened.affectedRows ?? 0;
      });
    }
    const totals = await this.#database.query<{ open: number; closed: number; net_pnl: string }>(
      `SELECT count(*) FILTER (WHERE status = 'OPEN')::int AS open,
              count(*) FILTER (WHERE status = 'CLOSED')::int AS closed,
              COALESCE(sum(net_pnl_usd) FILTER (WHERE status = 'CLOSED'), 0)::text AS net_pnl
       FROM paper_positions`,
    );
    return {
      asOf,
      mode: "SHADOW_PAPER",
      strategyVersion,
      repaired: repaired.affectedRows ?? 0,
      entered,
      noTrade,
      closed,
      portfolio: totals.rows[0],
    };
  }

  public async labelMaturedOutcomes(
    asOf: string = new Date().toISOString(),
    maximumDelayMinutes = 15,
  ): Promise<number> {
    const result = await this.#database.query<{
      record_hash: string;
      pool_id: string;
      observed_at: Date | string;
      price: string;
    }>(
      `SELECT record_hash, pool_id, observed_at, price::text
       FROM dex_market_observations
       WHERE price > 0
       ORDER BY pool_id, observed_at, record_hash`,
    );
    const byPool = new Map<
      string,
      { recordHash: string; observedAt: string; timestamp: number; price: Decimal }[]
    >();
    for (const row of result.rows) {
      const observedAt =
        row.observed_at instanceof Date ? row.observed_at.toISOString() : row.observed_at;
      const item = {
        recordHash: row.record_hash,
        observedAt,
        timestamp: new Date(observedAt).getTime(),
        price: new Decimal(row.price),
      };
      const pool = byPool.get(row.pool_id) ?? [];
      pool.push(item);
      byPool.set(row.pool_id, pool);
    }
    const horizons = [
      ["1h", 60 * 60_000],
      ["6h", 6 * 60 * 60_000],
      ["24h", 24 * 60 * 60_000],
      ["7d", 7 * 24 * 60 * 60_000],
      ["30d", 30 * 24 * 60 * 60_000],
    ] as const;
    const asOfTimestamp = new Date(asOf).getTime();
    const maximumDelayMs = maximumDelayMinutes * 60_000;
    let labeled = 0;
    for (const observations of byPool.values()) {
      for (const [entryIndex, entry] of observations.entries()) {
        for (const [horizon, durationMs] of horizons) {
          const targetTimestamp = entry.timestamp + durationMs;
          if (targetTimestamp > asOfTimestamp) continue;
          const exitIndex = observations.findIndex(
            (candidate, index) =>
              index > entryIndex &&
              candidate.timestamp >= targetTimestamp &&
              candidate.timestamp <= targetTimestamp + maximumDelayMs,
          );
          if (exitIndex < 0) continue;
          // exitIndex is produced by findIndex over this same local array.
          // eslint-disable-next-line security/detect-object-injection
          const exit = observations[exitIndex];
          if (!exit) continue;
          const path = observations.slice(entryIndex, exitIndex + 1);
          const returns = path.map((item) =>
            item.price.minus(entry.price).div(entry.price).mul(100),
          );
          const returnPct = exit.price.minus(entry.price).div(entry.price).mul(100);
          const favorable = Decimal.max(...returns);
          const adverse = Decimal.min(...returns);
          const insert = await this.#database.query(
            `INSERT INTO forward_outcomes
              (entry_record_hash, horizon, entry_at, target_at, exit_at, entry_price,
               exit_price, return_pct, maximum_favorable_excursion_pct,
               maximum_adverse_excursion_pct, labeling_version, labeled_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11)
             ON CONFLICT (entry_record_hash, horizon, labeling_version) DO NOTHING`,
            [
              entry.recordHash,
              horizon,
              entry.observedAt,
              new Date(targetTimestamp).toISOString(),
              exit.observedAt,
              entry.price.toString(),
              exit.price.toString(),
              returnPct.toString(),
              favorable.toString(),
              adverse.toString(),
              asOf,
            ],
          );
          labeled += insert.affectedRows ?? 0;
        }
      }
    }
    return labeled;
  }

  public async labelCapitalEventForwardOutcomes(
    asOf: string = new Date().toISOString(),
    maximumEntryAgeSeconds = 30,
    maximumExitDelaySeconds = 60,
    maximumEvents = 10_000,
  ): Promise<number> {
    if (!Number.isInteger(maximumEntryAgeSeconds) || maximumEntryAgeSeconds < 1)
      throw new Error("maximumEntryAgeSeconds must be a positive integer");
    if (!Number.isInteger(maximumExitDelaySeconds) || maximumExitDelaySeconds < 1)
      throw new Error("maximumExitDelaySeconds must be a positive integer");
    if (!Number.isInteger(maximumEvents) || maximumEvents < 1 || maximumEvents > 100_000)
      throw new Error("maximumEvents must be between 1 and 100000");
    const nativeSolAssetId = deterministicDomainId("asset", "solana:native:SOL");
    const prices = await this.#database.query<{
      snapshot_id: string;
      as_of: Date | string;
      price: string;
    }>(
      `SELECT snapshot_id, as_of, price::text FROM reference_price_snapshots
       WHERE base_asset = 'SOL' AND quote_asset = 'USD' AND status = 'PUBLISHED'
         AND as_of <= $1 ORDER BY as_of, snapshot_id`,
      [asOf],
    );
    const timeline = prices.rows.map((row) => ({
      snapshotId: row.snapshot_id,
      asOf: toIsoTimestamp(row.as_of),
      timestamp: new Date(toIsoTimestamp(row.as_of)).getTime(),
      price: new Decimal(row.price),
    }));
    if (timeline.length === 0) return 0;
    const earliestEligibleEvent = new Date(
      (timeline[0]?.timestamp ?? 0) - maximumEntryAgeSeconds * 1000,
    ).toISOString();
    const events = await this.#database.query<{
      event_id: string;
      event_time: Date | string;
    }>(
      `SELECT event.event_id, event.event_time
       FROM capital_events event
       WHERE event.asset_id = $1 AND event.event_time >= $2 AND event.event_time <= $3
         AND EXISTS (
           SELECT 1 FROM reference_price_snapshots entry
           WHERE entry.base_asset = 'SOL' AND entry.quote_asset = 'USD'
             AND entry.status = 'PUBLISHED' AND entry.as_of <= event.event_time
             AND entry.as_of >= event.event_time - $5 * interval '1 second'
         )
         AND EXISTS (
           SELECT 1
           FROM (VALUES ('1m',60),('5m',300),('15m',900),('1h',3600),('6h',21600),('24h',86400))
                horizon(name, seconds)
           WHERE event.event_time + horizon.seconds * interval '1 second' <= $3
             AND EXISTS (
               SELECT 1 FROM reference_price_snapshots exit
               WHERE exit.base_asset = 'SOL' AND exit.quote_asset = 'USD'
                 AND exit.status = 'PUBLISHED'
                 AND exit.as_of >= event.event_time + horizon.seconds * interval '1 second'
                 AND exit.as_of <= event.event_time +
                   (horizon.seconds + $6) * interval '1 second'
             )
             AND NOT EXISTS (
               SELECT 1 FROM capital_event_forward_outcomes outcome
               WHERE outcome.event_id = event.event_id
                 AND outcome.horizon = horizon.name AND outcome.labeling_version = 1
             )
         )
       ORDER BY EXISTS (
                  SELECT 1 FROM filtered_transaction_capital_events filtered
                  WHERE filtered.event_id = event.event_id
                ) DESC,
                EXISTS (
                  SELECT 1 FROM capital_flow_episodes episode
                  WHERE episode.anchor_event_id = event.event_id
                ) DESC,
                event.event_time DESC,
                event.event_id DESC
       LIMIT $4`,
      [
        nativeSolAssetId,
        earliestEligibleEvent,
        asOf,
        maximumEvents,
        maximumEntryAgeSeconds,
        maximumExitDelaySeconds,
      ],
    );
    const horizons = [
      ["1m", 60_000],
      ["5m", 5 * 60_000],
      ["15m", 15 * 60_000],
      ["1h", 60 * 60_000],
      ["6h", 6 * 60 * 60_000],
      ["24h", 24 * 60 * 60_000],
    ] as const;
    const asOfTimestamp = new Date(asOf).getTime();
    const maximumEntryAgeMs = maximumEntryAgeSeconds * 1000;
    const maximumExitDelayMs = maximumExitDelaySeconds * 1000;
    let labeled = 0;
    for (const event of events.rows) {
      const eventAt = toIsoTimestamp(event.event_time);
      const eventTimestamp = new Date(eventAt).getTime();
      const entry = timeline.findLast(
        (candidate) =>
          candidate.timestamp <= eventTimestamp &&
          candidate.timestamp >= eventTimestamp - maximumEntryAgeMs,
      );
      if (!entry) continue;
      for (const [horizon, durationMs] of horizons) {
        const targetTimestamp = eventTimestamp + durationMs;
        if (targetTimestamp > asOfTimestamp) continue;
        const exit = timeline.find(
          (candidate) =>
            candidate.timestamp >= targetTimestamp &&
            candidate.timestamp <= targetTimestamp + maximumExitDelayMs,
        );
        if (!exit) continue;
        const path = timeline.filter(
          (candidate) =>
            candidate.timestamp >= entry.timestamp && candidate.timestamp <= exit.timestamp,
        );
        const returns = path.map((candidate) =>
          candidate.price.minus(entry.price).div(entry.price).mul(100),
        );
        const returnPct = exit.price.minus(entry.price).div(entry.price).mul(100);
        const identity = {
          eventId: event.event_id,
          horizon,
          entrySnapshotId: entry.snapshotId,
          exitSnapshotId: exit.snapshotId,
          eventAt,
          targetAt: new Date(targetTimestamp).toISOString(),
          exitAt: exit.asOf,
          entryPrice: entry.price.toString(),
          exitPrice: exit.price.toString(),
          returnPct: returnPct.toString(),
          maximumFavorableExcursionPct: Decimal.max(...returns).toString(),
          maximumAdverseExcursionPct: Decimal.min(...returns).toString(),
          entryAgeMs: eventTimestamp - entry.timestamp,
          labelingVersion: 1,
          labeledAt: asOf,
        };
        const inserted = await this.#database.query(
          `INSERT INTO capital_event_forward_outcomes
            (event_id, horizon, entry_snapshot_id, exit_snapshot_id, event_at, target_at,
             exit_at, entry_price, exit_price, return_pct, maximum_favorable_excursion_pct,
             maximum_adverse_excursion_pct, entry_age_ms, labeling_version, labeled_at, content_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$15)
           ON CONFLICT (event_id, horizon, labeling_version) DO NOTHING`,
          [
            identity.eventId,
            identity.horizon,
            identity.entrySnapshotId,
            identity.exitSnapshotId,
            identity.eventAt,
            identity.targetAt,
            identity.exitAt,
            identity.entryPrice,
            identity.exitPrice,
            identity.returnPct,
            identity.maximumFavorableExcursionPct,
            identity.maximumAdverseExcursionPct,
            identity.entryAgeMs,
            identity.labeledAt,
            contentHash(identity),
          ],
        );
        labeled += inserted.affectedRows ?? 0;
      }
    }
    return labeled;
  }

  public async labelCapitalEventBenchmarkOutcomes(input: {
    readonly venue: string;
    readonly instrumentId: string;
    readonly asOf: string;
    readonly maximumEntryAgeSeconds?: number;
    readonly maximumExitDelaySeconds?: number;
    readonly maximumEvents?: number;
  }): Promise<number> {
    const maximumEntryAgeSeconds = input.maximumEntryAgeSeconds ?? 30;
    const maximumExitDelaySeconds = input.maximumExitDelaySeconds ?? 60;
    const maximumEvents = input.maximumEvents ?? 10_000;
    if (!Number.isInteger(maximumEntryAgeSeconds) || maximumEntryAgeSeconds < 1)
      throw new Error("maximum benchmark entry age must be positive");
    if (!Number.isInteger(maximumExitDelaySeconds) || maximumExitDelaySeconds < 1)
      throw new Error("maximum benchmark exit delay must be positive");
    if (!Number.isInteger(maximumEvents) || maximumEvents < 1 || maximumEvents > 100_000)
      throw new Error("maximum benchmark events must be between 1 and 100000");
    const trades = await this.#database.query<{
      event_id: string;
      event_time: Date | string;
      price: string;
    }>(
      `SELECT event_id, event_time, price::text
       FROM canonical_market_events
       WHERE venue = $1 AND instrument_id = $2 AND event_type = 'TRADE'
         AND price IS NOT NULL AND event_time <= $3
       ORDER BY event_time, event_id`,
      [input.venue, input.instrumentId, input.asOf],
    );
    const timeline = trades.rows.map((trade) => ({
      eventId: trade.event_id,
      eventAt: toIsoTimestamp(trade.event_time),
      timestamp: new Date(toIsoTimestamp(trade.event_time)).getTime(),
      price: new Decimal(trade.price),
    }));
    if (timeline.length === 0) return 0;
    const earliestEventAt = new Date(
      (timeline[0]?.timestamp ?? 0) - maximumEntryAgeSeconds * 1000,
    ).toISOString();
    const candidates = await this.#database.query<{
      event_id: string;
      horizon: string;
      event_at: Date | string;
      target_at: Date | string;
      sol_return_pct: string;
    }>(
      `SELECT outcome.event_id, outcome.horizon, outcome.event_at, outcome.target_at,
              outcome.return_pct::text AS sol_return_pct
       FROM capital_event_forward_outcomes outcome
       WHERE outcome.event_at >= $1 AND outcome.target_at <= $2
         AND NOT EXISTS (
           SELECT 1 FROM capital_event_benchmark_outcomes benchmark
           WHERE benchmark.event_id = outcome.event_id AND benchmark.horizon = outcome.horizon
             AND benchmark.benchmark_instrument_id = $3 AND benchmark.labeling_version = 1
         )
       ORDER BY EXISTS (
                  SELECT 1 FROM capital_flow_episodes episode
                  WHERE episode.anchor_event_id = outcome.event_id
                ) DESC,
                outcome.event_at DESC, outcome.event_id, outcome.horizon
       LIMIT $4`,
      [earliestEventAt, input.asOf, input.instrumentId, maximumEvents],
    );
    let labeled = 0;
    for (const candidate of candidates.rows) {
      const eventAt = toIsoTimestamp(candidate.event_at);
      const targetAt = toIsoTimestamp(candidate.target_at);
      const eventTimestamp = new Date(eventAt).getTime();
      const targetTimestamp = new Date(targetAt).getTime();
      const entry = timeline.findLast(
        (trade) =>
          trade.timestamp <= eventTimestamp &&
          trade.timestamp >= eventTimestamp - maximumEntryAgeSeconds * 1000,
      );
      const exit = timeline.find(
        (trade) =>
          trade.timestamp >= targetTimestamp &&
          trade.timestamp <= targetTimestamp + maximumExitDelaySeconds * 1000,
      );
      if (!entry || !exit) continue;
      const benchmarkReturn = exit.price.minus(entry.price).div(entry.price).mul(100);
      const solReturn = new Decimal(candidate.sol_return_pct);
      const identity = {
        eventId: candidate.event_id,
        horizon: candidate.horizon,
        benchmarkInstrumentId: input.instrumentId,
        entryEventId: entry.eventId,
        exitEventId: exit.eventId,
        eventAt,
        targetAt,
        exitAt: exit.eventAt,
        benchmarkEntryPrice: entry.price.toString(),
        benchmarkExitPrice: exit.price.toString(),
        benchmarkReturnPct: benchmarkReturn.toString(),
        solReturnPct: solReturn.toString(),
        excessReturnPct: solReturn.minus(benchmarkReturn).toString(),
        labelingVersion: 1,
        labeledAt: input.asOf,
      };
      const inserted = await this.#database.query(
        `INSERT INTO capital_event_benchmark_outcomes
          (event_id, horizon, benchmark_instrument_id, entry_event_id, exit_event_id,
           event_at, target_at, exit_at, benchmark_entry_price, benchmark_exit_price,
           benchmark_return_pct, sol_return_pct, excess_return_pct, labeling_version,
           labeled_at, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$15)
         ON CONFLICT (event_id, horizon, benchmark_instrument_id, labeling_version) DO NOTHING`,
        [
          identity.eventId,
          identity.horizon,
          identity.benchmarkInstrumentId,
          identity.entryEventId,
          identity.exitEventId,
          identity.eventAt,
          identity.targetAt,
          identity.exitAt,
          identity.benchmarkEntryPrice,
          identity.benchmarkExitPrice,
          identity.benchmarkReturnPct,
          identity.solReturnPct,
          identity.excessReturnPct,
          identity.labeledAt,
          contentHash(identity),
        ],
      );
      labeled += inserted.affectedRows ?? 0;
    }
    return labeled;
  }

  public async close(): Promise<void> {
    await this.#database.close();
  }

  public async tradingBotsReport(): Promise<Record<string, unknown>> {
    const strategy = await this.#database.query<{
      definitions: number;
      snapshots: number;
      pending: number;
      processing: number;
      complete: number;
      failed: number;
      evaluations: number;
      proposals: number;
    }>(`SELECT
      (SELECT count(*)::int FROM strategy_service_definitions) AS definitions,
      (SELECT count(*)::int FROM strategy_feature_snapshots) AS snapshots,
      count(*) FILTER (WHERE status='PENDING')::int AS pending,
      count(*) FILTER (WHERE status='PROCESSING')::int AS processing,
      count(*) FILTER (WHERE status='COMPLETE')::int AS complete,
      count(*) FILTER (WHERE status='FAILED')::int AS failed,
      (SELECT count(*)::int FROM strategy_evaluations) AS evaluations,
      (SELECT count(*)::int FROM strategy_trade_proposals) AS proposals
      FROM strategy_evaluation_jobs`);
    const pipeline = await this.#database.query<{
      pending: number;
      processing: number;
      complete: number;
      failed: number;
      runs: number;
      simulated: number;
      rejected: number;
      halted: number;
    }>(`SELECT
      count(*) FILTER (WHERE status='PENDING')::int AS pending,
      count(*) FILTER (WHERE status='PROCESSING')::int AS processing,
      count(*) FILTER (WHERE status='COMPLETE')::int AS complete,
      count(*) FILTER (WHERE status='FAILED')::int AS failed,
      (SELECT count(*)::int FROM paper_agent_runs) AS runs,
      (SELECT count(*)::int FROM paper_agent_runs WHERE outcome='SIMULATED_AND_RECONCILED') AS simulated,
      (SELECT count(*)::int FROM paper_agent_runs WHERE outcome='REJECTED') AS rejected,
      (SELECT count(*)::int FROM paper_agent_runs WHERE outcome='HALTED') AS halted
      FROM paper_agent_jobs`);
    return {
      authority: "PAPER_ONLY_NO_EXECUTION",
      observedAt: new Date().toISOString(),
      strategy: strategy.rows[0],
      pipeline: pipeline.rows[0],
    };
  }

  public async persistCapitalBatch(
    block: RawBlock,
    candidate: NormalizedCapitalBatch,
  ): Promise<CapitalBatchPersistenceResult> {
    if (block.chain !== "solana") throw new Error("capital batch requires a Solana raw block");
    const rawRef = contentHash(block);
    if (candidate.provenance.rawObjectRef !== rawRef)
      throw new Error("capital batch provenance does not match its raw block");

    const entities = candidate.entities.map((entity) => EntitySchema.parse(entity));
    const events = candidate.events.map((event) => CapitalEventSchema.parse(event));
    const assetIds = new Set(candidate.assets.map((asset) => asset.assetId));
    const entityIds = new Set(entities.map((entity) => entity.entityId));
    for (const event of events) {
      if (event.rawRef !== rawRef) throw new Error("capital event is not bound to its raw block");
      if (!assetIds.has(event.assetId)) throw new Error("capital event references an absent asset");
      if (event.fromEntityId && !entityIds.has(event.fromEntityId))
        throw new Error("capital event references an absent source entity");
      if (event.toEntityId && !entityIds.has(event.toEntityId))
        throw new Error("capital event references an absent destination entity");
    }

    return this.#database.transaction(async (transaction) => {
      await persistRawObject(transaction, rawRef, block, candidate.provenance.ingestedAt);
      const rawProjection = JSON.stringify({
        rawObjectRef: rawRef,
        payloadHash: contentHash(block.payload),
      });
      const raw = await transaction.query(
        `INSERT INTO raw_observations
          (observation_id, ingestion_id, source, source_id, observed_at, source_time, slot,
           schema_version, payload, payload_hash, record_hash, raw_object_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
         ON CONFLICT (record_hash) DO NOTHING`,
        [
          deterministicDomainId("observation", rawRef),
          deterministicDomainId(
            "ingestion",
            `${candidate.provenance.sourceProvider}:${candidate.provenance.sourceId}:${rawRef}`,
          ),
          candidate.provenance.sourceProvider,
          candidate.provenance.sourceId,
          candidate.provenance.ingestedAt,
          candidate.provenance.observedAt,
          block.sequence,
          Number(candidate.provenance.schemaVersion),
          rawProjection,
          contentHash(block.payload),
          rawRef,
          rawRef,
        ],
      );
      const rawBlock = await transaction.query(
        `INSERT INTO raw_chain_blocks
          (provider_id, chain, slot, provider_ref, source_time, ingested_at, payload, payload_hash,
           raw_object_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
         ON CONFLICT (provider_id, chain, slot) DO NOTHING`,
        [
          candidate.provenance.sourceProvider,
          block.chain,
          block.sequence,
          block.providerRef,
          block.sourceTimestamp,
          candidate.provenance.ingestedAt,
          rawProjection,
          contentHash(block.payload),
          rawRef,
        ],
      );

      const assetRows = candidate.assets.map((asset) => {
        if (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 18)
          throw new Error("invalid normalized capital asset");
        return {
          asset_id: asset.assetId,
          chain: asset.chain,
          mint: asset.mint,
          token_program: asset.tokenProgram,
          decimals: asset.decimals,
          metadata_status: asset.metadataStatus,
          first_observed_at: asset.firstObservedAt,
        };
      });
      const assetInsert = await transaction.query(
        `INSERT INTO assets
          (asset_id, chain, mint, token_program, decimals, metadata_status, first_observed_at)
         SELECT asset_id, chain, mint, token_program, decimals, metadata_status, first_observed_at
         FROM jsonb_to_recordset($1::jsonb) AS x(
           asset_id text, chain text, mint text, token_program text, decimals smallint,
           metadata_status text, first_observed_at timestamptz)
         ON CONFLICT (asset_id) DO NOTHING`,
        [JSON.stringify(assetRows)],
      );
      const storedAssets = await transaction.query<{
        asset_id: string;
        chain: string;
        mint: string;
        token_program: string;
        decimals: number;
        metadata_status: string;
      }>(
        `SELECT asset_id, chain, mint, token_program, decimals, metadata_status FROM assets
         WHERE asset_id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
        [JSON.stringify(candidate.assets.map((asset) => asset.assetId))],
      );
      const assetsById = new Map(storedAssets.rows.map((row) => [row.asset_id, row]));
      for (const asset of candidate.assets) {
        const row = assetsById.get(asset.assetId);
        if (
          row?.chain !== asset.chain ||
          row.mint !== asset.mint ||
          row.token_program !== asset.tokenProgram ||
          row.decimals !== asset.decimals ||
          row.metadata_status !== asset.metadataStatus
        )
          throw new Error("asset identity collision");
      }

      const entityRows = entities.map((entity) => ({
        entity_id: entity.entityId,
        entity_type: entity.entityType,
        labels: entity.labels,
        addresses: entity.addresses,
        attribution: entity.attribution,
        confidence: entity.confidence,
        first_seen: entity.firstSeen,
        last_seen: entity.lastSeen,
        evidence: entity.evidence,
        schema_version: Number(entity.schemaVersion),
        record_hash: contentHash(entity),
      }));
      const entityInsert = await transaction.query(
        `INSERT INTO entities
          (entity_id, entity_type, labels, addresses, attribution, confidence, first_seen,
           last_seen, evidence, schema_version, record_hash)
         SELECT entity_id, entity_type, labels, addresses, attribution, confidence, first_seen,
                last_seen, evidence, schema_version, record_hash
         FROM jsonb_to_recordset($1::jsonb) AS x(
           entity_id text, entity_type text, labels jsonb, addresses jsonb, attribution text,
           confidence numeric, first_seen timestamptz, last_seen timestamptz, evidence jsonb,
           schema_version integer, record_hash text)
         ON CONFLICT (entity_id) DO NOTHING`,
        [JSON.stringify(entityRows)],
      );
      const storedEntities = await transaction.query<{
        entity_id: string;
        entity_type: string;
        addresses: unknown;
      }>(
        `SELECT entity_id, entity_type, addresses FROM entities
         WHERE entity_id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
        [JSON.stringify(entities.map((entity) => entity.entityId))],
      );
      await transaction.query(
        `INSERT INTO entity_addresses (entity_id, address)
         SELECT entity_id, address.value
         FROM jsonb_to_recordset($1::jsonb) AS entity_row(entity_id text, addresses jsonb)
         CROSS JOIN LATERAL jsonb_array_elements_text(entity_row.addresses) address(value)
         ON CONFLICT (entity_id, address) DO NOTHING`,
        [
          JSON.stringify(
            entities.map((entity) => ({
              entity_id: entity.entityId,
              addresses: entity.addresses,
            })),
          ),
        ],
      );
      const entitiesById = new Map(storedEntities.rows.map((row) => [row.entity_id, row]));
      for (const entity of entities) {
        const row = entitiesById.get(entity.entityId);
        const addresses = Array.isArray(row?.addresses) ? row.addresses : [];
        if (
          row?.entity_type !== entity.entityType ||
          entity.addresses.some((address) => !addresses.includes(address))
        )
          throw new Error("entity identity collision");
      }

      const eventRows = events.map((event) => ({
        event_id: event.eventId,
        event_time: event.eventTime,
        ingest_time: event.ingestTime,
        source: event.source,
        chain: event.chain,
        venue: event.venue ?? null,
        event_type: event.eventType,
        asset_id: event.assetId,
        quantity: event.quantity,
        usd_value_at_event: event.usdValueAtEvent,
        from_entity_id: event.fromEntityId ?? null,
        to_entity_id: event.toEntityId ?? null,
        transaction_hash: event.transactionHash ?? null,
        confidence: event.confidence,
        raw_ref: event.rawRef,
        schema_version: Number(event.schemaVersion),
        record_hash: contentHash(event),
      }));
      const eventInsert = await transaction.query(
        `INSERT INTO capital_events
          (event_id, event_time, ingest_time, source, chain, venue, event_type, asset_id,
           quantity, usd_value_at_event, from_entity_id, to_entity_id, transaction_hash,
           confidence, raw_ref, schema_version, record_hash)
         SELECT event_id, event_time, ingest_time, source, chain, venue, event_type, asset_id,
                quantity, usd_value_at_event, from_entity_id, to_entity_id, transaction_hash,
                confidence, raw_ref, schema_version, record_hash
         FROM jsonb_to_recordset($1::jsonb) AS x(
           event_id text, event_time timestamptz, ingest_time timestamptz, source text, chain text,
           venue text, event_type text, asset_id text, quantity numeric, usd_value_at_event numeric,
           from_entity_id text, to_entity_id text, transaction_hash text, confidence numeric,
           raw_ref text, schema_version integer, record_hash text)
         ON CONFLICT (event_id) DO NOTHING`,
        [JSON.stringify(eventRows)],
      );
      const storedEvents = await transaction.query<{ event_id: string; record_hash: string }>(
        `SELECT event_id, record_hash FROM capital_events
         WHERE event_id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
        [JSON.stringify(events.map((event) => event.eventId))],
      );
      const eventHashes = new Map(storedEvents.rows.map((row) => [row.event_id, row.record_hash]));
      for (const event of events) {
        if (eventHashes.get(event.eventId) !== contentHash(event))
          throw new Error("capital-event identity collision");
      }

      const eventIdsBySignature = new Map<string, string[]>();
      for (const event of events) {
        if (!event.transactionHash) continue;
        const eventIds = eventIdsBySignature.get(event.transactionHash) ?? [];
        eventIds.push(event.eventId);
        eventIdsBySignature.set(event.transactionHash, eventIds);
      }
      const transactionSignatures = (() => {
        const payload: unknown = block.payload;
        if (typeof payload !== "object" || payload === null || !("transactions" in payload))
          return [];
        const rawTransactions: unknown = (payload as { readonly transactions?: unknown })
          .transactions;
        if (!Array.isArray(rawTransactions)) return [];
        const signatures: string[] = [];
        for (const item of rawTransactions as unknown[]) {
          if (typeof item !== "object" || item === null || !("transaction" in item)) continue;
          const rawTransaction: unknown = (item as { readonly transaction?: unknown }).transaction;
          if (
            typeof rawTransaction !== "object" ||
            rawTransaction === null ||
            !("signatures" in rawTransaction)
          )
            continue;
          const rawSignatures: unknown = (rawTransaction as { readonly signatures?: unknown })
            .signatures;
          if (!Array.isArray(rawSignatures)) continue;
          const signature: unknown = rawSignatures[0];
          if (typeof signature === "string") signatures.push(signature);
        }
        return signatures;
      })();
      if (transactionSignatures.length > 0) {
        const reconciled = await transaction.query<{
          provider_id: string;
          filter_id: string;
          signature: string;
        }>(
          `SELECT provider_id, filter_id, signature
           FROM filtered_transaction_reconciliations
           WHERE status = 'FINALIZED'
             AND signature IN (SELECT jsonb_array_elements_text($1::jsonb))`,
          [JSON.stringify(transactionSignatures)],
        );
        for (const row of reconciled.rows) {
          const eventIds = eventIdsBySignature.get(row.signature) ?? [];
          const normalization = {
            providerId: row.provider_id,
            filterId: row.filter_id,
            signature: row.signature,
            parserVersion: Number(candidate.provenance.parserVersion),
            rawBlockHash: rawRef,
            eventCount: eventIds.length,
            normalizedAt: candidate.provenance.ingestedAt,
          };
          const normalizationInsert = await transaction.query(
            `INSERT INTO filtered_transaction_normalizations
              (provider_id, filter_id, signature, parser_version, raw_block_hash, event_count,
               normalized_at, record_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (provider_id, filter_id, signature, parser_version) DO NOTHING`,
            [
              normalization.providerId,
              normalization.filterId,
              normalization.signature,
              normalization.parserVersion,
              normalization.rawBlockHash,
              normalization.eventCount,
              normalization.normalizedAt,
              contentHash(normalization),
            ],
          );
          if ((normalizationInsert.affectedRows ?? 0) === 0) {
            const existing = await transaction.query<{ record_hash: string }>(
              `SELECT record_hash FROM filtered_transaction_normalizations
               WHERE provider_id = $1 AND filter_id = $2 AND signature = $3
                 AND parser_version = $4`,
              [row.provider_id, row.filter_id, row.signature, normalization.parserVersion],
            );
            if (existing.rows[0]?.record_hash !== contentHash(normalization))
              throw new Error(`filtered normalization identity collision: ${row.signature}`);
          }
          if (eventIds.length > 0)
            await transaction.query(
              `INSERT INTO filtered_transaction_capital_events
                (provider_id, filter_id, signature, parser_version, event_id)
               SELECT $1,$2,$3,$4,event_id
               FROM jsonb_array_elements_text($5::jsonb) event_id
               ON CONFLICT DO NOTHING`,
              [
                row.provider_id,
                row.filter_id,
                row.signature,
                normalization.parserVersion,
                JSON.stringify(eventIds),
              ],
            );
        }
      }

      return {
        rawObservationsInserted: raw.affectedRows ?? 0,
        rawBlocksInserted: rawBlock.affectedRows ?? 0,
        assetsInserted: assetInsert.affectedRows ?? 0,
        entitiesInserted: entityInsert.affectedRows ?? 0,
        eventsInserted: eventInsert.affectedRows ?? 0,
      };
    });
  }

  public async capitalEvent(eventId: string): Promise<CapitalEvent | undefined> {
    const result = await this.#database.query<{
      event_id: string;
      event_time: Date | string;
      ingest_time: Date | string;
      source: string;
      chain: string;
      venue: string | null;
      event_type: CapitalEvent["eventType"];
      asset_id: string;
      quantity: string;
      usd_value_at_event: string | null;
      from_entity_id: string | null;
      to_entity_id: string | null;
      transaction_hash: string | null;
      confidence: number | string;
      raw_ref: `sha256:${string}`;
      schema_version: number;
    }>(
      `SELECT event_id, event_time, ingest_time, source, chain, venue, event_type, asset_id,
              quantity::text, usd_value_at_event::text, from_entity_id, to_entity_id,
              transaction_hash, confidence::text, raw_ref, schema_version
       FROM capital_events WHERE event_id = $1`,
      [eventId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return CapitalEventSchema.parse({
      eventId: row.event_id,
      eventTime: toIsoTimestamp(row.event_time),
      ingestTime: toIsoTimestamp(row.ingest_time),
      source: row.source,
      chain: row.chain,
      ...(row.venue === null ? {} : { venue: row.venue }),
      eventType: row.event_type,
      assetId: row.asset_id,
      quantity: new Decimal(row.quantity).toFixed(),
      usdValueAtEvent:
        row.usd_value_at_event === null ? null : new Decimal(row.usd_value_at_event).toFixed(),
      ...(row.from_entity_id === null ? {} : { fromEntityId: row.from_entity_id }),
      ...(row.to_entity_id === null ? {} : { toEntityId: row.to_entity_id }),
      ...(row.transaction_hash === null ? {} : { transactionHash: row.transaction_hash }),
      confidence: Number(row.confidence),
      rawRef: row.raw_ref,
      schemaVersion: String(row.schema_version),
    });
  }

  public async capitalEventDetail(eventId: string): Promise<CapitalEventDetail | undefined> {
    const event = await this.capitalEvent(eventId);
    if (!event) return undefined;
    const entityDetail = async (
      entityId: string | undefined,
    ): Promise<CapitalEventDetail["fromEntity"]> => {
      if (!entityId) return undefined;
      const result = await this.#database.query<{
        entity_id: string;
        addresses: readonly string[];
        label: string | null;
        entity_type: string | null;
        source: string | null;
      }>(
        `SELECT entity.entity_id, entity.addresses,
                attribution.label, attribution.entity_type, attribution.source
         FROM entities entity
         LEFT JOIN LATERAL (
           SELECT verified.label, verified.entity_type, verified.source
           FROM entity_addresses address
           JOIN verified_entity_addresses verified ON verified.address = address.address
           WHERE address.entity_id = entity.entity_id
             AND verified.retrieved_at <= $2
             AND verified.valid_from <= $2
             AND (verified.valid_to IS NULL OR verified.valid_to >= $2)
           ORDER BY verified.valid_from DESC LIMIT 1
         ) attribution ON true
         WHERE entity.entity_id = $1`,
        [entityId, event.eventTime],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        entityId: row.entity_id,
        addresses: row.addresses,
        ...(row.label === null ? {} : { label: row.label }),
        ...(row.entity_type === null ? {} : { entityType: row.entity_type }),
        ...(row.source === null ? {} : { attributionSource: row.source }),
      };
    };
    const [fromEntity, toEntity, protocolResult, outcomeResult, reactionResult] = await Promise.all(
      [
        entityDetail(event.fromEntityId),
        entityDetail(event.toEntityId),
        event.venue
          ? this.#database.query<{
              address: string;
              label: string;
              entity_type: string;
              source: string;
            }>(
              `SELECT address, label, entity_type, source FROM verified_entity_addresses
             WHERE address = $1 AND retrieved_at <= $2 AND valid_from <= $2
               AND (valid_to IS NULL OR valid_to >= $2)
             ORDER BY valid_from DESC LIMIT 1`,
              [event.venue, event.eventTime],
            )
          : Promise.resolve({ rows: [] }),
        this.#database.query<{
          horizon: string;
          exit_at: Date | string;
          return_pct: string;
          maximum_favorable_excursion_pct: string;
          maximum_adverse_excursion_pct: string;
        }>(
          `SELECT horizon, exit_at, return_pct::text, maximum_favorable_excursion_pct::text,
                maximum_adverse_excursion_pct::text
         FROM capital_event_forward_outcomes WHERE event_id = $1
         ORDER BY exit_at, horizon`,
          [eventId],
        ),
        this.#database.query<{
          feature_id: string;
          venue: string;
          instrument_id: string;
          window_seconds: number;
          window_start: Date | string;
          window_end: Date | string;
          before_snapshot_hash: `sha256:${string}`;
          after_snapshot_hash: `sha256:${string}`;
          features: MarketReactionFeatures;
          content_hash: `sha256:${string}`;
        }>(
          `SELECT feature_id, venue, instrument_id, window_seconds, window_start, window_end,
                before_snapshot_hash, after_snapshot_hash, features, content_hash
         FROM capital_event_market_reactions WHERE capital_event_id = $1
         ORDER BY window_seconds, venue, instrument_id`,
          [eventId],
        ),
      ],
    );
    const protocol = protocolResult.rows[0];
    return {
      event,
      ...(fromEntity ? { fromEntity } : {}),
      ...(toEntity ? { toEntity } : {}),
      ...(protocol
        ? {
            protocol: {
              address: protocol.address,
              label: protocol.label,
              entityType: protocol.entity_type,
              source: protocol.source,
            },
          }
        : {}),
      outcomes: outcomeResult.rows.map((row) => ({
        horizon: row.horizon,
        exitAt: toIsoTimestamp(row.exit_at),
        returnPct: new Decimal(row.return_pct).toFixed(),
        maximumFavorableExcursionPct: new Decimal(row.maximum_favorable_excursion_pct).toFixed(),
        maximumAdverseExcursionPct: new Decimal(row.maximum_adverse_excursion_pct).toFixed(),
      })),
      marketReactions: reactionResult.rows.map((row) => ({
        featureId: row.feature_id,
        capitalEventId: eventId,
        venue: row.venue,
        instrumentId: row.instrument_id,
        windowSeconds: row.window_seconds,
        windowStart: toIsoTimestamp(row.window_start),
        windowEnd: toIsoTimestamp(row.window_end),
        beforeSnapshotHash: row.before_snapshot_hash,
        afterSnapshotHash: row.after_snapshot_hash,
        features: row.features,
        contentHash: row.content_hash,
      })),
    };
  }

  public chainCollectionStorage(
    ingestedAt: () => string = () => new Date().toISOString(),
  ): ChainCheckpointStore & RawBlockSink {
    const database = this.#database;
    const appendMany = async (blocks: readonly RawBlock[]): Promise<void> => {
      if (blocks.length === 0) return;
      const prepared = blocks.map((block) => ({
        block,
        payloadHash: contentHash(block.payload),
        rawRef: contentHash(block),
        storedAt: ingestedAt(),
      }));
      await database.transaction(async (transaction) => {
        for (const item of prepared) {
          await persistRawObject(transaction, item.rawRef, item.block, item.storedAt);
          await transaction.query(
            `INSERT INTO raw_chain_blocks
              (provider_id, chain, slot, provider_ref, source_time, ingested_at, payload,
               payload_hash, raw_object_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
             ON CONFLICT (provider_id, chain, slot) DO NOTHING`,
            [
              "solana-rpc",
              item.block.chain,
              item.block.sequence,
              item.block.providerRef,
              item.block.sourceTimestamp,
              item.storedAt,
              JSON.stringify({ rawObjectRef: item.rawRef, payloadHash: item.payloadHash }),
              item.payloadHash,
              item.rawRef,
            ],
          );
          await transaction.query(
            `INSERT INTO chain_normalization_jobs
              (raw_object_hash, parser_version, provider_id, chain, slot, status, attempts,
               available_at, created_at, updated_at)
             VALUES ($1,3,$2,$3,$4,'PENDING',0,$5,$5,$5)
             ON CONFLICT (raw_object_hash, parser_version) DO NOTHING`,
            [item.rawRef, "solana-rpc", item.block.chain, item.block.sequence, item.storedAt],
          );
        }
      });
    };
    return {
      async load(providerId: string, chain: "solana"): Promise<ChainCheckpoint | undefined> {
        const result = await database.query<{
          last_finalized_slot: string | number;
          updated_at: Date | string;
        }>(
          `SELECT last_finalized_slot, updated_at FROM chain_collection_checkpoints
           WHERE provider_id = $1 AND chain = $2`,
          [providerId, chain],
        );
        const row = result.rows[0];
        if (!row) return undefined;
        const lastFinalizedSlot = Number(row.last_finalized_slot);
        if (!Number.isSafeInteger(lastFinalizedSlot)) throw new Error("stored slot is not safe");
        return {
          providerId,
          chain,
          lastFinalizedSlot,
          updatedAt: toIsoTimestamp(row.updated_at),
        };
      },
      async save(checkpoint: ChainCheckpoint): Promise<void> {
        await database.query(
          `INSERT INTO chain_collection_checkpoints
            (provider_id, chain, last_finalized_slot, updated_at)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (provider_id, chain) DO UPDATE SET
             last_finalized_slot = EXCLUDED.last_finalized_slot,
             updated_at = EXCLUDED.updated_at
           WHERE chain_collection_checkpoints.last_finalized_slot < EXCLUDED.last_finalized_slot`,
          [
            checkpoint.providerId,
            checkpoint.chain,
            checkpoint.lastFinalizedSlot,
            checkpoint.updatedAt,
          ],
        );
      },
      async recordGap(gap: SlotGap): Promise<void> {
        await database.query(
          `INSERT INTO chain_collection_gaps
            (provider_id, chain, start_slot, end_slot, detected_at, reason)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [gap.providerId, gap.chain, gap.startSlot, gap.endSlot, gap.detectedAt, gap.reason],
        );
      },
      appendMany,
      async append(block: RawBlock): Promise<void> {
        await appendMany([block]);
      },
    };
  }

  public async claimChainNormalizationJobs(
    now: string,
    leaseMs: number,
    limit: number,
  ): Promise<readonly ChainNormalizationJob[]> {
    if (!Number.isInteger(leaseMs) || leaseMs < 1000) throw new Error("lease must be at least 1s");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("claim limit must be between 1 and 100");
    const leaseCutoff = new Date(new Date(now).getTime() - leaseMs).toISOString();
    const result = await this.#database.query<{
      raw_object_hash: `sha256:${string}`;
      parser_version: number;
      provider_id: string;
      chain: string;
      slot: string;
      attempts: number;
      created_at: Date | string;
    }>(
      `WITH candidates AS (
         SELECT raw_object_hash, parser_version
         FROM chain_normalization_jobs
         WHERE (status = 'PENDING' AND available_at <= $1)
            OR (status = 'PROCESSING' AND claimed_at <= $2)
         ORDER BY slot, raw_object_hash
         FOR UPDATE SKIP LOCKED
         LIMIT $3
       )
       UPDATE chain_normalization_jobs AS job
       SET status = 'PROCESSING', attempts = job.attempts + 1, claimed_at = $1,
           updated_at = $1, last_error = NULL
       FROM candidates
       WHERE job.raw_object_hash = candidates.raw_object_hash
         AND job.parser_version = candidates.parser_version
       RETURNING job.raw_object_hash, job.parser_version, job.provider_id, job.chain,
                 job.slot::text, job.attempts, job.created_at`,
      [now, leaseCutoff, limit],
    );
    return result.rows.map((row) => ({
      rawObjectHash: row.raw_object_hash,
      parserVersion: row.parser_version,
      providerId: row.provider_id,
      chain: row.chain,
      slot: row.slot,
      attempts: row.attempts,
      createdAt: toIsoTimestamp(row.created_at),
    }));
  }

  public async chainNormalizationQueueStatus(): Promise<ChainNormalizationQueueStatus> {
    const result = await this.#database.query<{
      pending: string | number;
      processing: string | number;
      complete: string | number;
      failed: string | number;
      oldest_pending_at: Date | string | null;
    }>(
      `SELECT
         count(*) FILTER (WHERE status = 'PENDING') AS pending,
         count(*) FILTER (WHERE status = 'PROCESSING') AS processing,
         count(*) FILTER (WHERE status = 'COMPLETE') AS complete,
         count(*) FILTER (WHERE status = 'FAILED') AS failed,
         min(created_at) FILTER (WHERE status = 'PENDING') AS oldest_pending_at
       FROM chain_normalization_jobs`,
    );
    const row = result.rows[0];
    if (!row) return { pending: 0, processing: 0, complete: 0, failed: 0 };
    return {
      pending: Number(row.pending),
      processing: Number(row.processing),
      complete: Number(row.complete),
      failed: Number(row.failed),
      ...(row.oldest_pending_at === null
        ? {}
        : { oldestPendingAt: toIsoTimestamp(row.oldest_pending_at) }),
    };
  }

  public async enforceRawRetention(
    cutoffAt: string,
    maximumObjects: number,
    executedAt = new Date().toISOString(),
  ): Promise<RawRetentionResult> {
    if (Number.isNaN(new Date(cutoffAt).getTime())) throw new Error("invalid retention cutoff");
    if (!Number.isInteger(maximumObjects) || maximumObjects < 1 || maximumObjects > 10_000)
      throw new Error("maximumObjects must be between 1 and 10000");
    return this.#database.transaction(async (transaction) => {
      const candidates = await transaction.query<{
        object_hash: `sha256:${string}`;
        compressed_bytes: string | number;
      }>(
        `SELECT object_hash, compressed_bytes
         FROM raw_objects AS object
         WHERE object.created_at < $1
           AND NOT EXISTS (
             SELECT 1 FROM chain_normalization_jobs AS job
             WHERE job.raw_object_hash = object.object_hash
               AND job.status IN ('PENDING', 'PROCESSING')
           )
           AND NOT EXISTS (
             SELECT 1 FROM solana_token_account_owner_observations AS owner
             WHERE owner.raw_object_hash = object.object_hash
           )
           AND NOT EXISTS (
             SELECT 1 FROM raw_filtered_transactions AS filtered
             WHERE filtered.raw_object_hash = object.object_hash
           )
           AND NOT EXISTS (
             SELECT 1 FROM entity_source_snapshots AS snapshot
             WHERE snapshot.raw_object_hash = object.object_hash
           )
           AND NOT EXISTS (
             SELECT 1 FROM solana_owner_extractions AS extraction
             WHERE extraction.raw_object_hash = object.object_hash
           )
           AND NOT EXISTS (
             SELECT 1 FROM capital_event_owner_corrections AS correction
             WHERE correction.raw_object_hash = object.object_hash
           )
           AND NOT EXISTS (
             SELECT 1 FROM filtered_transaction_normalizations AS normalization
             WHERE normalization.raw_block_hash = object.object_hash
           )
         ORDER BY object.created_at, object.object_hash
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [cutoffAt, maximumObjects],
      );
      const hashes = candidates.rows.map((row) => row.object_hash);
      const encodedHashes = JSON.stringify(hashes);
      await transaction.query("SELECT set_config('cfie.retention_prune', 'enabled', true)");
      const jobs = await transaction.query(
        `DELETE FROM chain_normalization_jobs
         WHERE raw_object_hash IN (SELECT jsonb_array_elements_text($1::jsonb))
           AND status IN ('COMPLETE', 'FAILED')`,
        [encodedHashes],
      );
      const chainBlocks = await transaction.query(
        `DELETE FROM raw_chain_blocks
         WHERE raw_object_hash IN (SELECT jsonb_array_elements_text($1::jsonb))`,
        [encodedHashes],
      );
      const marketMessages = await transaction.query(
        `DELETE FROM raw_public_market_messages
         WHERE raw_object_hash IN (SELECT jsonb_array_elements_text($1::jsonb))`,
        [encodedHashes],
      );
      const observations = await transaction.query(
        `UPDATE raw_observations SET raw_object_hash = NULL
         WHERE raw_object_hash IN (SELECT jsonb_array_elements_text($1::jsonb))`,
        [encodedHashes],
      );
      const objects = await transaction.query(
        `DELETE FROM raw_objects
         WHERE object_hash IN (SELECT jsonb_array_elements_text($1::jsonb))`,
        [encodedHashes],
      );
      const result: RawRetentionResult = {
        retentionRunId: deterministicDomainId(
          "retention",
          `${cutoffAt}:${executedAt}:${encodedHashes}`,
        ),
        cutoffAt,
        executedAt,
        maximumObjects,
        objectsDeleted: objects.affectedRows ?? 0,
        compressedBytesDeleted: candidates.rows.reduce(
          (sum, row) => sum + Number(row.compressed_bytes),
          0,
        ),
        chainBlocksDeleted: chainBlocks.affectedRows ?? 0,
        marketMessagesDeleted: marketMessages.affectedRows ?? 0,
        normalizationJobsDeleted: jobs.affectedRows ?? 0,
        rawObservationLinksCleared: observations.affectedRows ?? 0,
      };
      if (result.objectsDeleted !== hashes.length)
        throw new Error("retention candidate set changed during pruning");
      await transaction.query(
        `INSERT INTO raw_retention_runs
          (retention_run_id, cutoff_at, executed_at, maximum_objects, objects_deleted,
           compressed_bytes_deleted, chain_blocks_deleted, market_messages_deleted,
           normalization_jobs_deleted, raw_observation_links_cleared)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          result.retentionRunId,
          result.cutoffAt,
          result.executedAt,
          result.maximumObjects,
          result.objectsDeleted,
          result.compressedBytesDeleted,
          result.chainBlocksDeleted,
          result.marketMessagesDeleted,
          result.normalizationJobsDeleted,
          result.rawObservationLinksCleared,
        ],
      );
      return result;
    });
  }

  public async recentRawRetentionRuns(limit = 20): Promise<readonly RawRetentionResult[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("retention run limit must be between 1 and 100");
    const result = await this.#database.query<{
      retention_run_id: string;
      cutoff_at: Date | string;
      executed_at: Date | string;
      maximum_objects: number;
      objects_deleted: number;
      compressed_bytes_deleted: string | number;
      chain_blocks_deleted: number;
      market_messages_deleted: number;
      normalization_jobs_deleted: number;
      raw_observation_links_cleared: number;
    }>(
      `SELECT retention_run_id, cutoff_at, executed_at, maximum_objects, objects_deleted,
              compressed_bytes_deleted, chain_blocks_deleted, market_messages_deleted,
              normalization_jobs_deleted, raw_observation_links_cleared
       FROM raw_retention_runs ORDER BY executed_at DESC, retention_run_id DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      retentionRunId: row.retention_run_id,
      cutoffAt: toIsoTimestamp(row.cutoff_at),
      executedAt: toIsoTimestamp(row.executed_at),
      maximumObjects: row.maximum_objects,
      objectsDeleted: row.objects_deleted,
      compressedBytesDeleted: Number(row.compressed_bytes_deleted),
      chainBlocksDeleted: row.chain_blocks_deleted,
      marketMessagesDeleted: row.market_messages_deleted,
      normalizationJobsDeleted: row.normalization_jobs_deleted,
      rawObservationLinksCleared: row.raw_observation_links_cleared,
    }));
  }

  public async cfieDemoReport(): Promise<CfieDemoReport> {
    const incidentCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const [
      counts,
      capital,
      market,
      evidence,
      referencePrices,
      capitalOutcomes,
      normalizationQueue,
      operationalHealth,
      recentRetentionRuns,
      attribution,
      filteredStream,
      researchRuns,
      directionalOutcomes,
      protocolInteractionOutcomes,
      registryQuality,
      collectionService,
      horizonMaturation,
      latestMarketRegime,
      episodeReadiness,
      recentEpisodes,
      recentIncidentSummary,
      collectionGapSummary,
    ] = await Promise.all([
      this.#database.query<{
        raw_objects: string | number;
        chain_blocks: string | number;
        capital_events: string | number;
        entities: string | number;
        assets: string | number;
        market_events: string | number;
        raw_market_messages: string | number;
        evidence_packets: string | number;
        market_data_incidents: string | number;
        reference_price_snapshots: string | number;
        capital_event_forward_outcomes: string | number;
        capital_event_benchmark_outcomes: string | number;
        market_reaction_features: string | number;
        market_regime_snapshots: string | number;
        capital_flow_episodes: string | number;
        verified_entity_addresses: string | number;
        filtered_transactions: string | number;
        reconciled_filtered_transactions: string | number;
        normalized_filtered_transactions: string | number;
        research_analysis_runs: string | number;
      }>(`SELECT
          (SELECT count(*) FROM raw_objects) AS raw_objects,
          (SELECT count(*) FROM raw_chain_blocks) AS chain_blocks,
          (SELECT count(*) FROM capital_events) AS capital_events,
          (SELECT count(*) FROM entities) AS entities,
          (SELECT count(*) FROM assets) AS assets,
          (SELECT count(*) FROM canonical_market_events) AS market_events,
          (SELECT count(*) FROM raw_public_market_messages) AS raw_market_messages,
          (SELECT count(*) FROM evidence_packets) AS evidence_packets,
          (SELECT count(*) FROM market_data_incidents) AS market_data_incidents,
          (SELECT count(*) FROM reference_price_snapshots) AS reference_price_snapshots,
          (SELECT count(*) FROM capital_event_forward_outcomes) AS capital_event_forward_outcomes,
          (SELECT count(*) FROM capital_event_benchmark_outcomes) AS capital_event_benchmark_outcomes,
          (SELECT count(*) FROM capital_event_market_reactions) AS market_reaction_features,
          (SELECT count(*) FROM market_regime_snapshots) AS market_regime_snapshots,
          (SELECT count(*) FROM capital_flow_episodes) AS capital_flow_episodes,
          (SELECT count(*) FROM verified_entity_addresses) AS verified_entity_addresses,
          (SELECT count(*) FROM raw_filtered_transactions) AS filtered_transactions,
          (SELECT count(*) FROM filtered_transaction_reconciliations) AS reconciled_filtered_transactions,
          (SELECT count(*) FROM filtered_transaction_normalizations) AS normalized_filtered_transactions,
          (SELECT count(*) FROM research_analysis_runs) AS research_analysis_runs`),
      this.#database.query<{
        event_id: string;
        event_time: Date | string;
        event_type: string;
        asset_id: string;
        quantity: string;
        venue: string | null;
        venue_label: string | null;
        venue_entity_type: string | null;
        from_entity_id: string | null;
        to_entity_id: string | null;
        from_label: string | null;
        to_label: string | null;
        from_entity_type: string | null;
        to_entity_type: string | null;
      }>(`SELECT event.event_id, event.event_time, event.event_type, event.asset_id,
                event.quantity::text, event.venue, event.from_entity_id, event.to_entity_id,
                venue_attribution.label AS venue_label,
                venue_attribution.entity_type AS venue_entity_type,
                from_attribution.label AS from_label,
                from_attribution.entity_type AS from_entity_type,
                to_attribution.label AS to_label,
                to_attribution.entity_type AS to_entity_type
         FROM capital_events event
         LEFT JOIN LATERAL (
           SELECT verified.label, verified.entity_type
           FROM verified_entity_addresses verified
           WHERE verified.address = event.venue
             AND verified.retrieved_at <= event.event_time
             AND verified.valid_from <= event.event_time
             AND (verified.valid_to IS NULL OR verified.valid_to >= event.event_time)
           ORDER BY verified.valid_from DESC LIMIT 1
         ) venue_attribution ON true
         LEFT JOIN LATERAL (
           SELECT verified.label, verified.entity_type
           FROM entity_addresses address
           JOIN verified_entity_addresses verified ON verified.address = address.address
           WHERE address.entity_id = event.from_entity_id
             AND verified.retrieved_at <= event.event_time
             AND verified.valid_from <= event.event_time
             AND (verified.valid_to IS NULL OR verified.valid_to >= event.event_time)
           ORDER BY verified.valid_from DESC LIMIT 1
         ) from_attribution ON true
         LEFT JOIN LATERAL (
           SELECT verified.label, verified.entity_type
           FROM entity_addresses address
           JOIN verified_entity_addresses verified ON verified.address = address.address
           WHERE address.entity_id = event.to_entity_id
             AND verified.retrieved_at <= event.event_time
             AND verified.valid_from <= event.event_time
             AND (verified.valid_to IS NULL OR verified.valid_to >= event.event_time)
           ORDER BY verified.valid_from DESC LIMIT 1
         ) to_attribution ON true
         ORDER BY event.event_time DESC, event.event_id DESC LIMIT 20`),
      this.#database.query<{
        event_id: string;
        event_time: Date | string;
        instrument_id: string;
        event_type: string;
        price: string | null;
        quantity: string | null;
        side: string | null;
      }>(`SELECT event_id, event_time, instrument_id, event_type, price::text, quantity::text, side
         FROM canonical_market_events ORDER BY event_time DESC, event_id DESC LIMIT 20`),
      this.#database.query<{ packet: unknown }>(
        `SELECT packet FROM evidence_packets ORDER BY generated_at DESC, packet_id DESC LIMIT 10`,
      ),
      this.#database.query<{ estimate: ReferencePriceEstimate }>(
        `SELECT estimate FROM reference_price_snapshots ORDER BY as_of DESC, snapshot_id DESC LIMIT 10`,
      ),
      this.#database.query<{
        event_id: string;
        horizon: string;
        event_at: Date | string;
        exit_at: Date | string;
        return_pct: string;
        maximum_favorable_excursion_pct: string;
        maximum_adverse_excursion_pct: string;
      }>(
        `SELECT event_id, horizon, event_at, exit_at, return_pct::text,
                maximum_favorable_excursion_pct::text, maximum_adverse_excursion_pct::text
         FROM capital_event_forward_outcomes ORDER BY exit_at DESC, event_id DESC LIMIT 20`,
      ),
      this.chainNormalizationQueueStatus(),
      this.operationalHealth(),
      this.recentRawRetentionRuns(10),
      this.#database.query<{
        endpoint_count: string | number;
        verified_endpoint_count: string | number;
      }>(`WITH dashboard_events AS MATERIALIZED (
           SELECT event_id, event_time, from_entity_id, to_entity_id
           FROM capital_events ORDER BY event_time DESC, event_id DESC LIMIT 100000
         )
         SELECT
           (SELECT count(from_entity_id) + count(to_entity_id) FROM dashboard_events)
             AS endpoint_count,
           (SELECT count(*) FROM (
              SELECT event.event_id
              FROM entity_addresses address
              JOIN verified_entity_addresses verified ON verified.address = address.address
              JOIN dashboard_events event ON event.from_entity_id = address.entity_id
              WHERE verified.retrieved_at <= event.event_time
                AND verified.valid_from <= event.event_time
                AND (verified.valid_to IS NULL OR verified.valid_to >= event.event_time)
              GROUP BY event.event_id
              UNION ALL
              SELECT event.event_id
              FROM entity_addresses address
              JOIN verified_entity_addresses verified ON verified.address = address.address
              JOIN dashboard_events event ON event.to_entity_id = address.entity_id
              WHERE verified.retrieved_at <= event.event_time
                AND verified.valid_from <= event.event_time
                AND (verified.valid_to IS NULL OR verified.valid_to >= event.event_time)
              GROUP BY event.event_id
            ) verified_endpoints) AS verified_endpoint_count`),
      this.#database.query<{
        pending: string | number;
        finalized: string | number;
        missing: string | number;
        failed: string | number;
        latest_received_at: Date | string | null;
        latest_reconciled_at: Date | string | null;
        normalized: string | number;
        linked_capital_events: string | number;
      }>(`SELECT base.*,
                 (SELECT count(*) FROM filtered_transaction_normalizations) AS normalized,
                 (SELECT count(*) FROM filtered_transaction_capital_events) AS linked_capital_events
          FROM (
            SELECT count(*) FILTER (WHERE reconciliation.signature IS NULL) AS pending,
                   count(*) FILTER (WHERE reconciliation.status = 'FINALIZED') AS finalized,
                   count(*) FILTER (WHERE reconciliation.status = 'MISSING') AS missing,
                   count(*) FILTER (WHERE reconciliation.status = 'FAILED') AS failed,
                   max(transaction.received_at) AS latest_received_at,
                   max(reconciliation.reconciled_at) AS latest_reconciled_at
            FROM raw_filtered_transactions transaction
            LEFT JOIN filtered_transaction_reconciliations reconciliation
              ON reconciliation.provider_id = transaction.provider_id
             AND reconciliation.filter_id = transaction.filter_id
             AND reconciliation.signature = transaction.signature
          ) base`),
      this.#database.query<{
        run_id: string;
        protocol_id: string;
        analysis_family: string;
        generated_at: Date | string;
        status: string;
        observation_count: string | number;
        result: {
          minimumSampleSize?: number;
          cells?: readonly { significant?: boolean }[];
          falsification?: {
            control?: string;
            testedFindingCount?: number;
            survivingFindingCount?: number;
            randomizedTimestampAlignment?: {
              control?: string;
              trialCount?: number;
              testedFindingCount?: number;
              survivingFindingCount?: number;
            };
          };
        };
      }>(`SELECT run_id, protocol_id, analysis_family, generated_at, status,
                observation_count, result
         FROM research_analysis_runs ORDER BY generated_at DESC, run_id DESC LIMIT 10`),
      this.#database.query<{
        from_class: string;
        to_class: string;
        horizon: string;
        sample_size: string | number;
        mean_return_pct: string | number;
      }>(`WITH dashboard_events AS MATERIALIZED (
           SELECT * FROM capital_events ORDER BY event_time DESC, event_id DESC LIMIT 100000
         )
         SELECT COALESCE(from_attribution.entity_type, 'UNKNOWN') AS from_class,
                COALESCE(to_attribution.entity_type, 'UNKNOWN') AS to_class,
                outcome.horizon, count(*) AS sample_size,
                avg(outcome.return_pct)::text AS mean_return_pct
         FROM dashboard_events event
         JOIN capital_event_forward_outcomes outcome ON outcome.event_id = event.event_id
         LEFT JOIN LATERAL (
           SELECT verified.entity_type
           FROM entity_addresses address
           JOIN verified_entity_addresses verified ON verified.address = address.address
           WHERE address.entity_id = event.from_entity_id
             AND verified.retrieved_at <= event.event_time
             AND verified.valid_from <= event.event_time
             AND (verified.valid_to IS NULL OR verified.valid_to >= event.event_time)
           ORDER BY verified.valid_from DESC LIMIT 1
         ) from_attribution ON true
         LEFT JOIN LATERAL (
           SELECT verified.entity_type
           FROM entity_addresses address
           JOIN verified_entity_addresses verified ON verified.address = address.address
           WHERE address.entity_id = event.to_entity_id
             AND verified.retrieved_at <= event.event_time
             AND verified.valid_from <= event.event_time
             AND (verified.valid_to IS NULL OR verified.valid_to >= event.event_time)
           ORDER BY verified.valid_from DESC LIMIT 1
         ) to_attribution ON true
         GROUP BY from_class, to_class, outcome.horizon
         ORDER BY count(*) DESC, from_class, to_class, outcome.horizon
         LIMIT 30`),
      this.#database.query<{
        venue: string;
        venue_label: string;
        venue_entity_type: string;
        horizon: string;
        sample_size: string | number;
        mean_return_pct: string | number;
      }>(`WITH dashboard_events AS MATERIALIZED (
           SELECT * FROM capital_events WHERE venue IS NOT NULL
           ORDER BY event_time DESC, event_id DESC LIMIT 100000
         )
         SELECT event.venue, venue_attribution.label AS venue_label,
                venue_attribution.entity_type AS venue_entity_type,
                outcome.horizon, count(*) AS sample_size,
                avg(outcome.return_pct)::text AS mean_return_pct
         FROM dashboard_events event
         JOIN capital_event_forward_outcomes outcome ON outcome.event_id = event.event_id
         JOIN LATERAL (
           SELECT verified.label, verified.entity_type
           FROM verified_entity_addresses verified
           WHERE verified.address = event.venue
             AND verified.retrieved_at <= event.event_time
             AND verified.valid_from <= event.event_time
             AND (verified.valid_to IS NULL OR verified.valid_to >= event.event_time)
           ORDER BY verified.valid_from DESC LIMIT 1
         ) venue_attribution ON true
         GROUP BY event.venue, venue_attribution.label, venue_attribution.entity_type, outcome.horizon
         ORDER BY count(*) DESC, venue_attribution.label, outcome.horizon
         LIMIT 30`),
      this.#database.query<{
        address_count: string | number;
        source_count: string | number;
        single_source_address_count: string | number;
        conflicting_address_count: string | number;
      }>(`SELECT
           (SELECT count(DISTINCT address) FROM verified_entity_addresses) AS address_count,
           (SELECT count(DISTINCT source) FROM verified_entity_addresses) AS source_count,
           (SELECT count(*) FROM (
              SELECT address FROM verified_entity_addresses
              GROUP BY address HAVING count(DISTINCT source) = 1
            ) single_source) AS single_source_address_count,
           (SELECT count(DISTINCT left_record.address)
            FROM verified_entity_addresses left_record
            JOIN verified_entity_addresses right_record
              ON right_record.address = left_record.address
             AND right_record.record_hash > left_record.record_hash
             AND right_record.valid_from <= COALESCE(left_record.valid_to, '9999-12-31T23:59:59.999Z'::timestamptz)
             AND left_record.valid_from <= COALESCE(right_record.valid_to, '9999-12-31T23:59:59.999Z'::timestamptz)
             AND (right_record.entity_type <> left_record.entity_type OR right_record.label <> left_record.label)
           ) AS conflicting_address_count`),
      this.#database.query<{
        service_name: string;
        started_at: Date | string;
        heartbeat_at: Date | string;
        lease_expires_at: Date | string;
        status: "RUNNING" | "STOPPED" | "FAILED";
        last_error: string | null;
      }>(`SELECT service_name, acquired_at AS started_at, heartbeat_at, lease_expires_at, status, last_error
          FROM collection_service_leases
          ORDER BY heartbeat_at DESC, service_name LIMIT 1`),
      this.#database.query<{
        horizon: string;
        window_seconds: string | number;
        outcome_count: string | number;
        reaction_count: string | number;
        unique_reaction_timestamp_count: string | number;
        benchmark_outcome_count: string | number;
        filtered_outcome_count: string | number;
        filtered_reaction_count: string | number;
      }>(`WITH horizons(horizon, window_seconds) AS (
            VALUES ('1m',60),('5m',300),('15m',900),('1h',3600),('6h',21600),('24h',86400)
          ), outcomes AS (
            SELECT horizon, count(*) AS count
            FROM capital_event_forward_outcomes GROUP BY horizon
          ), reactions AS (
            SELECT reaction.window_seconds, count(*) AS count,
                   count(DISTINCT event.event_time) AS unique_timestamp_count
            FROM capital_event_market_reactions reaction
            JOIN capital_events event ON event.event_id = reaction.capital_event_id
            GROUP BY reaction.window_seconds
          ), benchmark_outcomes AS (
            SELECT horizon, count(*) AS count
            FROM capital_event_benchmark_outcomes GROUP BY horizon
          ), filtered_outcomes AS (
            SELECT outcome.horizon, count(DISTINCT outcome.event_id) AS count
            FROM capital_event_forward_outcomes outcome
            JOIN filtered_transaction_capital_events filtered ON filtered.event_id = outcome.event_id
            GROUP BY outcome.horizon
          ), filtered_reactions AS (
            SELECT reaction.window_seconds, count(DISTINCT reaction.capital_event_id) AS count
            FROM capital_event_market_reactions reaction
            JOIN filtered_transaction_capital_events filtered
              ON filtered.event_id = reaction.capital_event_id
            GROUP BY reaction.window_seconds
          )
          SELECT horizons.horizon, horizons.window_seconds,
                 COALESCE(outcomes.count, 0) AS outcome_count,
                 COALESCE(reactions.count, 0) AS reaction_count,
                 COALESCE(reactions.unique_timestamp_count, 0) AS unique_reaction_timestamp_count,
                 COALESCE(benchmark_outcomes.count, 0) AS benchmark_outcome_count,
                 COALESCE(filtered_outcomes.count, 0) AS filtered_outcome_count,
                 COALESCE(filtered_reactions.count, 0) AS filtered_reaction_count
          FROM horizons
          LEFT JOIN outcomes ON outcomes.horizon = horizons.horizon
          LEFT JOIN reactions ON reactions.window_seconds = horizons.window_seconds
          LEFT JOIN benchmark_outcomes ON benchmark_outcomes.horizon = horizons.horizon
          LEFT JOIN filtered_outcomes ON filtered_outcomes.horizon = horizons.horizon
          LEFT JOIN filtered_reactions ON filtered_reactions.window_seconds = horizons.window_seconds
          ORDER BY horizons.window_seconds`),
      this.#database.query<{ result: MarketRegimeResult }>(
        `SELECT result FROM market_regime_snapshots
         ORDER BY as_of DESC, regime_id DESC LIMIT 1`,
      ),
      this.#database.query<{
        episode_count: string | number;
        underlying_event_count: string | number;
        attributed_episode_count: string | number;
      }>(`SELECT count(*) AS episode_count,
                 COALESCE(sum(episode.event_count), 0) AS underlying_event_count,
                 count(*) FILTER (WHERE context.verified_event_count > 0)
                   AS attributed_episode_count
          FROM capital_flow_episodes episode
          LEFT JOIN capital_flow_episode_protocol_contexts context
            ON context.episode_id = episode.episode_id
           AND context.algorithm_version = episode.algorithm_version`),
      this.#database.query<{
        episode_id: string;
        window_start: Date | string;
        window_end: Date | string;
        event_count: number;
        total_quantity: string;
        maximum_quantity: string;
        dominant_cohort: string;
        verified_venue_event_count: string | number;
        primary_venue_label: string | null;
        primary_venue_entity_type: string | null;
      }>(`SELECT episode.episode_id, episode.window_start, episode.window_end,
                 episode.event_count, episode.total_quantity::text,
                 episode.maximum_quantity::text, episode.dominant_cohort,
                 COALESCE(context.verified_event_count, 0) AS verified_venue_event_count,
                 context.primary_venue_label,
                 context.primary_venue_entity_type
          FROM capital_flow_episodes episode
          LEFT JOIN capital_flow_episode_protocol_contexts context
            ON context.episode_id = episode.episode_id
           AND context.algorithm_version = episode.algorithm_version
          ORDER BY episode.window_start DESC, episode.episode_id DESC LIMIT 10`),
      this.#database.query<{
        incident_type: string;
        venue: string;
        product_id: string;
        count: string | number;
        first_detected_at: Date | string;
        last_detected_at: Date | string;
      }>(
        `SELECT incident_type, venue, COALESCE(product_id, 'ALL') AS product_id,
                count(*) AS count, min(detected_at) AS first_detected_at,
                max(detected_at) AS last_detected_at
         FROM market_data_incidents
         WHERE detected_at >= $1
         GROUP BY incident_type, venue, product_id
         ORDER BY count(*) DESC, venue, product_id`,
        [incidentCutoff],
      ),
      this.#database.query<{
        gap_count: string | number;
        skipped_slot_count: string | number;
        largest_gap_slots: string | number;
        live_tail_fast_forward_count: string | number;
        latest_detected_at: Date | string | null;
      }>(`SELECT count(*) AS gap_count,
                 COALESCE(sum(end_slot - start_slot + 1), 0) AS skipped_slot_count,
                 COALESCE(max(end_slot - start_slot + 1), 0) AS largest_gap_slots,
                 count(*) FILTER (WHERE reason = 'LIVE_TAIL_FAST_FORWARD')
                   AS live_tail_fast_forward_count,
                 max(detected_at) AS latest_detected_at
          FROM chain_collection_gaps`),
    ]);
    const row = counts.rows[0];
    if (!row) throw new Error("CFIE aggregate query returned no row");
    return {
      generatedAt: new Date().toISOString(),
      authority: "READ_ONLY_RESEARCH",
      dashboardSampleEventLimit: 100_000,
      counts: {
        rawObjects: Number(row.raw_objects),
        chainBlocks: Number(row.chain_blocks),
        capitalEvents: Number(row.capital_events),
        entities: Number(row.entities),
        assets: Number(row.assets),
        marketEvents: Number(row.market_events),
        rawMarketMessages: Number(row.raw_market_messages),
        evidencePackets: Number(row.evidence_packets),
        marketDataIncidents: Number(row.market_data_incidents),
        referencePriceSnapshots: Number(row.reference_price_snapshots),
        capitalEventForwardOutcomes: Number(row.capital_event_forward_outcomes),
        capitalEventBenchmarkOutcomes: Number(row.capital_event_benchmark_outcomes),
        marketReactionFeatures: Number(row.market_reaction_features),
        marketRegimeSnapshots: Number(row.market_regime_snapshots),
        capitalFlowEpisodes: Number(row.capital_flow_episodes),
        verifiedEntityAddresses: Number(row.verified_entity_addresses),
        filteredTransactions: Number(row.filtered_transactions),
        reconciledFilteredTransactions: Number(row.reconciled_filtered_transactions),
        normalizedFilteredTransactions: Number(row.normalized_filtered_transactions),
        researchAnalysisRuns: Number(row.research_analysis_runs),
      },
      entityAttribution: (() => {
        const endpointCount = Number(attribution.rows[0]?.endpoint_count ?? 0);
        const verifiedEndpointCount = Number(attribution.rows[0]?.verified_endpoint_count ?? 0);
        return {
          endpointCount,
          verifiedEndpointCount,
          coveragePct: endpointCount === 0 ? 0 : (verifiedEndpointCount / endpointCount) * 100,
        };
      })(),
      entityRegistryQuality: {
        addressCount: Number(registryQuality.rows[0]?.address_count ?? 0),
        sourceCount: Number(registryQuality.rows[0]?.source_count ?? 0),
        singleSourceAddressCount: Number(registryQuality.rows[0]?.single_source_address_count ?? 0),
        conflictingAddressCount: Number(registryQuality.rows[0]?.conflicting_address_count ?? 0),
      },
      collectionGapSummary: {
        gapCount: Number(collectionGapSummary.rows[0]?.gap_count ?? 0),
        skippedSlotCount: Number(collectionGapSummary.rows[0]?.skipped_slot_count ?? 0),
        largestGapSlots: Number(collectionGapSummary.rows[0]?.largest_gap_slots ?? 0),
        liveTailFastForwardCount: Number(
          collectionGapSummary.rows[0]?.live_tail_fast_forward_count ?? 0,
        ),
        ...(collectionGapSummary.rows[0]?.latest_detected_at == null
          ? {}
          : {
              latestDetectedAt: toIsoTimestamp(collectionGapSummary.rows[0].latest_detected_at),
            }),
      },
      filteredStream: {
        pending: Number(filteredStream.rows[0]?.pending ?? 0),
        finalized: Number(filteredStream.rows[0]?.finalized ?? 0),
        missing: Number(filteredStream.rows[0]?.missing ?? 0),
        failed: Number(filteredStream.rows[0]?.failed ?? 0),
        normalized: Number(filteredStream.rows[0]?.normalized ?? 0),
        linkedCapitalEvents: Number(filteredStream.rows[0]?.linked_capital_events ?? 0),
        ...(filteredStream.rows[0]?.latest_received_at == null
          ? {}
          : { latestReceivedAt: toIsoTimestamp(filteredStream.rows[0].latest_received_at) }),
        ...(filteredStream.rows[0]?.latest_reconciled_at == null
          ? {}
          : { latestReconciledAt: toIsoTimestamp(filteredStream.rows[0].latest_reconciled_at) }),
      },
      normalizationQueue,
      operationalHealth,
      collectionService: (() => {
        const service = collectionService.rows[0];
        if (!service) return { status: "NOT_CONFIGURED" as const };
        return {
          status: service.status,
          serviceName: service.service_name,
          startedAt: toIsoTimestamp(service.started_at),
          heartbeatAt: toIsoTimestamp(service.heartbeat_at),
          leaseExpiresAt: toIsoTimestamp(service.lease_expires_at),
          ...(service.last_error === null ? {} : { lastError: service.last_error }),
        };
      })(),
      horizonMaturation: horizonMaturation.rows.map((row) => ({
        horizon: row.horizon,
        windowSeconds: Number(row.window_seconds),
        outcomeCount: Number(row.outcome_count),
        reactionCount: Number(row.reaction_count),
        uniqueReactionTimestampCount: Number(row.unique_reaction_timestamp_count),
        benchmarkOutcomeCount: Number(row.benchmark_outcome_count),
        filteredOutcomeCount: Number(row.filtered_outcome_count),
        filteredReactionCount: Number(row.filtered_reaction_count),
      })),
      ...(latestMarketRegime.rows[0] === undefined
        ? {}
        : { latestMarketRegime: latestMarketRegime.rows[0].result }),
      episodeReadiness: (() => {
        const episodeCount = Number(episodeReadiness.rows[0]?.episode_count ?? 0);
        const underlyingEventCount = Number(episodeReadiness.rows[0]?.underlying_event_count ?? 0);
        return {
          episodeCount,
          underlyingEventCount,
          averageEventsPerEpisode: episodeCount === 0 ? 0 : underlyingEventCount / episodeCount,
          attributedEpisodeCount: Number(episodeReadiness.rows[0]?.attributed_episode_count ?? 0),
        };
      })(),
      recentCapitalFlowEpisodes: recentEpisodes.rows.map((episode) => ({
        episodeId: episode.episode_id,
        windowStart: toIsoTimestamp(episode.window_start),
        windowEnd: toIsoTimestamp(episode.window_end),
        eventCount: episode.event_count,
        totalQuantity: episode.total_quantity,
        maximumQuantity: episode.maximum_quantity,
        dominantCohort: episode.dominant_cohort,
        verifiedVenueEventCount: Number(episode.verified_venue_event_count),
        ...(episode.primary_venue_label === null
          ? {}
          : { primaryVenueLabel: episode.primary_venue_label }),
        ...(episode.primary_venue_entity_type === null
          ? {}
          : { primaryVenueEntityType: episode.primary_venue_entity_type }),
      })),
      recentIncidentSummary: recentIncidentSummary.rows.map((incident) => ({
        incidentType: incident.incident_type,
        venue: incident.venue,
        productId: incident.product_id,
        count: Number(incident.count),
        firstDetectedAt: toIsoTimestamp(incident.first_detected_at),
        lastDetectedAt: toIsoTimestamp(incident.last_detected_at),
      })),
      recentCapitalEvents: capital.rows.map((event) => ({
        eventId: event.event_id,
        eventTime: toIsoTimestamp(event.event_time),
        eventType: event.event_type,
        assetId: event.asset_id,
        quantity: event.quantity,
        ...(event.venue === null ? {} : { venue: event.venue }),
        ...(event.venue_label === null ? {} : { venueLabel: event.venue_label }),
        ...(event.venue_entity_type === null ? {} : { venueEntityType: event.venue_entity_type }),
        ...(event.from_entity_id === null ? {} : { fromEntityId: event.from_entity_id }),
        ...(event.to_entity_id === null ? {} : { toEntityId: event.to_entity_id }),
        ...(event.from_label === null ? {} : { fromLabel: event.from_label }),
        ...(event.to_label === null ? {} : { toLabel: event.to_label }),
        ...(event.from_entity_type === null ? {} : { fromEntityType: event.from_entity_type }),
        ...(event.to_entity_type === null ? {} : { toEntityType: event.to_entity_type }),
      })),
      recentMarketEvents: market.rows.map((event) => ({
        eventId: event.event_id,
        eventTime: toIsoTimestamp(event.event_time),
        instrumentId: event.instrument_id,
        eventType: event.event_type,
        ...(event.price === null ? {} : { price: event.price }),
        ...(event.quantity === null ? {} : { quantity: event.quantity }),
        ...(event.side === null ? {} : { side: event.side }),
      })),
      recentEvidencePackets: evidence.rows.map(({ packet }) => {
        const parsed = EvidencePacketSchema.parse(packet);
        return {
          packetId: parsed.packetId,
          detectedEventId: parsed.detectedEvent.eventId,
          generatedAt: parsed.generatedAt,
          action: parsed.action,
          dataQuality: parsed.dataQuality,
          confidence: parsed.confidence,
          contradictionCount: parsed.contradictions.length,
        };
      }),
      recentReferencePrices: referencePrices.rows.map(({ estimate }) => estimate),
      recentCapitalOutcomes: capitalOutcomes.rows.map((outcome) => ({
        eventId: outcome.event_id,
        horizon: outcome.horizon,
        eventAt: toIsoTimestamp(outcome.event_at),
        exitAt: toIsoTimestamp(outcome.exit_at),
        returnPct: outcome.return_pct,
        maximumFavorableExcursionPct: outcome.maximum_favorable_excursion_pct,
        maximumAdverseExcursionPct: outcome.maximum_adverse_excursion_pct,
      })),
      recentRetentionRuns,
      recentResearchRuns: researchRuns.rows.map((run) => {
        const validation = summarizeResearchValidation({
          status: run.status,
          minimumSampleSize: run.result.minimumSampleSize,
          cells: run.result.cells,
        });
        return {
          runId: run.run_id,
          protocolId: run.protocol_id,
          analysisFamily: run.analysis_family,
          generatedAt: toIsoTimestamp(run.generated_at),
          status: run.status,
          observationCount: Number(run.observation_count),
          significantCellCount: countSignificantCells(run.result.cells),
          validationVerdict: validation.verdict,
          eligibleHoldoutCount: validation.eligibleHoldoutCount,
          replicatedHoldoutCount: validation.replicatedHoldoutCount,
          ...(run.result.falsification?.control === undefined
            ? {}
            : { falsificationControl: run.result.falsification.control }),
          ...(run.result.falsification?.testedFindingCount === undefined
            ? {}
            : { falsificationTestedCount: run.result.falsification.testedFindingCount }),
          ...(run.result.falsification?.survivingFindingCount === undefined
            ? {}
            : { falsificationSurvivingCount: run.result.falsification.survivingFindingCount }),
          falsificationControls: [
            ...(run.result.falsification?.control === undefined
              ? []
              : [
                  {
                    control: run.result.falsification.control,
                    testedCount: run.result.falsification.testedFindingCount ?? 0,
                    survivingCount: run.result.falsification.survivingFindingCount ?? 0,
                  },
                ]),
            ...(run.result.falsification?.randomizedTimestampAlignment?.control === undefined
              ? []
              : [
                  {
                    control: run.result.falsification.randomizedTimestampAlignment.control,
                    testedCount:
                      run.result.falsification.randomizedTimestampAlignment.testedFindingCount ?? 0,
                    survivingCount:
                      run.result.falsification.randomizedTimestampAlignment.survivingFindingCount ??
                      0,
                    ...(run.result.falsification.randomizedTimestampAlignment.trialCount ===
                    undefined
                      ? {}
                      : {
                          trialCount:
                            run.result.falsification.randomizedTimestampAlignment.trialCount,
                        }),
                  },
                ]),
          ],
        };
      }),
      directionalOutcomes: directionalOutcomes.rows.map((outcome) => ({
        fromClass: outcome.from_class,
        toClass: outcome.to_class,
        horizon: outcome.horizon,
        sampleSize: Number(outcome.sample_size),
        meanReturnPct: new Decimal(outcome.mean_return_pct).toString(),
      })),
      protocolInteractionOutcomes: protocolInteractionOutcomes.rows.map((outcome) => ({
        venue: outcome.venue,
        venueLabel: outcome.venue_label,
        venueEntityType: outcome.venue_entity_type,
        horizon: outcome.horizon,
        sampleSize: Number(outcome.sample_size),
        meanReturnPct: new Decimal(outcome.mean_return_pct).toString(),
      })),
    };
  }

  public async operationalHealth(
    observedAt = new Date().toISOString(),
    freshnessLimitSeconds = 300,
    maximumPendingJobs = 1000,
  ): Promise<OperationalHealthSnapshot> {
    if (!Number.isInteger(freshnessLimitSeconds) || freshnessLimitSeconds < 1)
      throw new Error("freshness limit must be a positive integer");
    if (!Number.isInteger(maximumPendingJobs) || maximumPendingJobs < 1)
      throw new Error("maximum pending jobs must be a positive integer");
    const observedMs = new Date(observedAt).getTime();
    if (Number.isNaN(observedMs)) throw new Error("invalid health observation time");
    const [freshness, incidents, queue, filtered] = await Promise.all([
      this.#database.query<{
        latest_chain_block_at: Date | string | null;
        latest_chain_ingested_at: Date | string | null;
        latest_market_message_at: Date | string | null;
      }>(`SELECT
          (SELECT max(source_time) FROM raw_chain_blocks) AS latest_chain_block_at,
          (SELECT max(ingested_at) FROM raw_chain_blocks) AS latest_chain_ingested_at,
          (SELECT max(ingested_at) FROM raw_public_market_messages) AS latest_market_message_at`),
      this.#database.query<{ recent_count: string | number; active_count: string | number }>(
        `SELECT
           count(*) FILTER (WHERE detected_at >= $1) AS recent_count,
           count(*) FILTER (WHERE detected_at >= $2) AS active_count
         FROM market_data_incidents`,
        [
          new Date(observedMs - 60 * 60_000).toISOString(),
          new Date(observedMs - 5 * 60_000).toISOString(),
        ],
      ),
      this.chainNormalizationQueueStatus(),
      this.#database.query<{
        pending: string | number;
        failed: string | number;
        oldest_pending_at: Date | string | null;
      }>(`SELECT
           count(*) FILTER (WHERE reconciliation.signature IS NULL) AS pending,
           count(*) FILTER (WHERE reconciliation.status = 'FAILED') AS failed,
           min(transaction.received_at) FILTER (WHERE reconciliation.signature IS NULL) AS oldest_pending_at
         FROM raw_filtered_transactions transaction
         LEFT JOIN filtered_transaction_reconciliations reconciliation
           ON reconciliation.provider_id = transaction.provider_id
          AND reconciliation.filter_id = transaction.filter_id
          AND reconciliation.signature = transaction.signature`),
    ]);
    const row = freshness.rows[0];
    const latestChainBlockAt =
      row?.latest_chain_block_at == null ? undefined : toIsoTimestamp(row.latest_chain_block_at);
    const latestChainIngestedAt =
      row?.latest_chain_ingested_at == null
        ? undefined
        : toIsoTimestamp(row.latest_chain_ingested_at);
    const latestMarketMessageAt =
      row?.latest_market_message_at == null
        ? undefined
        : toIsoTimestamp(row.latest_market_message_at);
    const chainAgeSeconds =
      latestChainBlockAt === undefined
        ? undefined
        : Math.max(0, (observedMs - new Date(latestChainBlockAt).getTime()) / 1000);
    const marketAgeSeconds =
      latestMarketMessageAt === undefined
        ? undefined
        : Math.max(0, (observedMs - new Date(latestMarketMessageAt).getTime()) / 1000);
    const recentMarketIncidents = Number(incidents.rows[0]?.recent_count ?? 0);
    const activeMarketIncidents = Number(incidents.rows[0]?.active_count ?? 0);
    const pendingFilteredReconciliations = Number(filtered.rows[0]?.pending ?? 0);
    const failedFilteredReconciliations = Number(filtered.rows[0]?.failed ?? 0);
    const oldestFilteredPendingAt = filtered.rows[0]?.oldest_pending_at;
    const reasons: string[] = [];
    let status: OperationalHealthSnapshot["status"] = "HEALTHY";
    if (queue.failed > 0) {
      status = "UNHEALTHY";
      reasons.push(`${String(queue.failed)} normalization job(s) failed`);
    }
    if (queue.pending + queue.processing > maximumPendingJobs) {
      if (status === "HEALTHY") status = "DEGRADED";
      reasons.push("normalization queue exceeds its operating threshold");
    }
    if (chainAgeSeconds === undefined || chainAgeSeconds > freshnessLimitSeconds) {
      if (status === "HEALTHY") status = "DEGRADED";
      reasons.push(
        chainAgeSeconds === undefined ? "no chain block recorded" : "chain data is stale",
      );
    }
    if (marketAgeSeconds === undefined || marketAgeSeconds > freshnessLimitSeconds) {
      if (status === "HEALTHY") status = "DEGRADED";
      reasons.push(
        marketAgeSeconds === undefined ? "no market message recorded" : "market data is stale",
      );
    }
    if (activeMarketIncidents > 0) {
      if (status === "HEALTHY") status = "DEGRADED";
      reasons.push(
        `${String(activeMarketIncidents)} market-data incident(s) in the last 5 minutes`,
      );
    }
    if (failedFilteredReconciliations > 0) {
      status = "UNHEALTHY";
      reasons.push(
        `${String(failedFilteredReconciliations)} filtered reconciliation(s) permanently failed`,
      );
    }
    if (
      pendingFilteredReconciliations > 0 &&
      oldestFilteredPendingAt != null &&
      observedMs - new Date(toIsoTimestamp(oldestFilteredPendingAt)).getTime() >
        freshnessLimitSeconds * 1000
    ) {
      if (status === "HEALTHY") status = "DEGRADED";
      reasons.push("filtered transactions await finalized reconciliation");
    }
    return {
      observedAt,
      status,
      ...(latestChainBlockAt === undefined ? {} : { latestChainBlockAt }),
      ...(latestChainIngestedAt === undefined ? {} : { latestChainIngestedAt }),
      ...(latestMarketMessageAt === undefined ? {} : { latestMarketMessageAt }),
      ...(chainAgeSeconds === undefined ? {} : { chainAgeSeconds }),
      ...(marketAgeSeconds === undefined ? {} : { marketAgeSeconds }),
      recentMarketIncidents,
      activeMarketIncidents,
      pendingFilteredReconciliations,
      failedFilteredReconciliations,
      queue,
      reasons,
    };
  }

  public async persistMarketDataIncident(input: {
    readonly incidentType: "SEQUENCE_GAP" | "RECONNECT";
    readonly source: string;
    readonly venue: string;
    readonly productId?: string;
    readonly expectedSequence?: string;
    readonly receivedSequence?: string;
    readonly detectedAt: string;
    readonly details: Readonly<Record<string, unknown>>;
  }): Promise<boolean> {
    const identity = {
      ...input,
      expectedSequence: input.expectedSequence ?? null,
      receivedSequence: input.receivedSequence ?? null,
      productId: input.productId ?? null,
    };
    const recordHash = contentHash(identity);
    const result = await this.#database.query(
      `INSERT INTO market_data_incidents
        (incident_id, incident_type, source, venue, product_id, expected_sequence,
         received_sequence, detected_at, details, record_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       ON CONFLICT (record_hash) DO NOTHING`,
      [
        deterministicDomainId("incident", recordHash),
        input.incidentType,
        input.source,
        input.venue,
        input.productId ?? null,
        input.expectedSequence ?? null,
        input.receivedSequence ?? null,
        input.detectedAt,
        JSON.stringify(input.details),
        recordHash,
      ],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  public async completeChainNormalizationJob(
    rawObjectHash: `sha256:${string}`,
    parserVersion: number,
    completedAt: string,
  ): Promise<void> {
    const result = await this.#database.query(
      `UPDATE chain_normalization_jobs
       SET status = 'COMPLETE', completed_at = $3, updated_at = $3
       WHERE raw_object_hash = $1 AND parser_version = $2 AND status = 'PROCESSING'`,
      [rawObjectHash, parserVersion, completedAt],
    );
    if ((result.affectedRows ?? 0) !== 1) throw new Error("normalization job is not processing");
  }

  public async failChainNormalizationJob(
    rawObjectHash: `sha256:${string}`,
    parserVersion: number,
    attempts: number,
    failedAt: string,
    retryAt: string,
    maximumAttempts: number,
    error: string,
  ): Promise<ChainNormalizationFailureResult> {
    const status = attempts >= maximumAttempts ? "FAILED" : "PENDING";
    const result = await this.#database.query<{ attempts: number }>(
      `UPDATE chain_normalization_jobs
       SET status = $4, available_at = $5, claimed_at = NULL, updated_at = $6,
           last_error = $7
       WHERE raw_object_hash = $1 AND parser_version = $2
         AND status = 'PROCESSING' AND attempts = $3
       RETURNING attempts`,
      [rawObjectHash, parserVersion, attempts, status, retryAt, failedAt, error.slice(0, 2000)],
    );
    const row = result.rows[0];
    if (!row) throw new Error("normalization job lease changed before failure was recorded");
    return { status, attempts: row.attempts };
  }

  public async persistMarketEvent(candidate: MarketEvent): Promise<boolean> {
    const event = MarketEventSchema.parse(candidate);
    const result = await this.#database.query(
      `INSERT INTO canonical_market_events
        (event_id, event_time, ingest_time, source, venue, instrument_id, event_type,
         price, quantity, side, bid, ask, book_sequence, raw_ref, schema_version, record_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        event.eventId,
        event.eventTime,
        event.ingestTime,
        event.source,
        event.venue,
        event.instrumentId,
        event.eventType,
        event.price ?? null,
        event.quantity ?? null,
        event.side ?? null,
        event.bid ?? null,
        event.ask ?? null,
        event.bookSequence ?? null,
        event.rawRef,
        Number(event.schemaVersion),
        contentHash(event),
      ],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  public async loadMarketTradeCheckpoint(
    source: string,
    venue: string,
    productId: string,
  ): Promise<number | undefined> {
    const result = await this.#database.query<{ cursor_value: string | number }>(
      `SELECT cursor_value FROM market_stream_checkpoints
       WHERE source = $1 AND venue = $2 AND product_id = $3 AND cursor_type = 'TRADE_ID'`,
      [source, venue, productId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const value = Number(row.cursor_value);
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("persisted market trade checkpoint is outside the safe integer range");
    return value;
  }

  public async saveMarketTradeCheckpoint(
    source: string,
    venue: string,
    productId: string,
    tradeId: number,
    updatedAt: string,
  ): Promise<void> {
    if (!Number.isSafeInteger(tradeId) || tradeId < 0)
      throw new Error("tradeId must be a non-negative safe integer");
    await this.#database.query(
      `INSERT INTO market_stream_checkpoints
        (source, venue, product_id, cursor_type, cursor_value, updated_at)
       VALUES ($1,$2,$3,'TRADE_ID',$4,$5)
       ON CONFLICT (source, venue, product_id, cursor_type) DO UPDATE
       SET cursor_value = EXCLUDED.cursor_value, updated_at = EXCLUDED.updated_at
       WHERE market_stream_checkpoints.cursor_value < EXCLUDED.cursor_value`,
      [source, venue, productId, tradeId, updatedAt],
    );
  }

  public async acquireCollectionServiceLease(
    serviceName: string,
    ownerId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<boolean> {
    const result = await this.#database.query(
      `INSERT INTO collection_service_leases
        (service_name, owner_id, acquired_at, heartbeat_at, lease_expires_at, status, last_error)
       VALUES ($1,$2,$3,$3,$4,'RUNNING',NULL)
       ON CONFLICT (service_name) DO UPDATE
       SET owner_id = EXCLUDED.owner_id, acquired_at = EXCLUDED.acquired_at,
           heartbeat_at = EXCLUDED.heartbeat_at, lease_expires_at = EXCLUDED.lease_expires_at,
           status = 'RUNNING', last_error = NULL
       WHERE collection_service_leases.owner_id = EXCLUDED.owner_id
          OR collection_service_leases.lease_expires_at < EXCLUDED.heartbeat_at
          OR collection_service_leases.status <> 'RUNNING'`,
      [serviceName, ownerId, now, leaseExpiresAt],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  public async heartbeatCollectionServiceLease(
    serviceName: string,
    ownerId: string,
    heartbeatAt: string,
    leaseExpiresAt: string,
    lastError?: string,
  ): Promise<boolean> {
    const result = await this.#database.query(
      `UPDATE collection_service_leases
       SET heartbeat_at = $3, lease_expires_at = $4, status = 'RUNNING', last_error = $5
       WHERE service_name = $1 AND owner_id = $2 AND status = 'RUNNING'`,
      [serviceName, ownerId, heartbeatAt, leaseExpiresAt, lastError ?? null],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  public async releaseCollectionServiceLease(
    serviceName: string,
    ownerId: string,
    stoppedAt: string,
    status: "STOPPED" | "FAILED",
    lastError?: string,
  ): Promise<boolean> {
    const result = await this.#database.query(
      `UPDATE collection_service_leases
       SET heartbeat_at = $3, lease_expires_at = $3, status = $4, last_error = $5
       WHERE service_name = $1 AND owner_id = $2`,
      [serviceName, ownerId, stoppedAt, status, lastError ?? null],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  public async persistHistoricalMarketBatch(
    candidates: readonly HistoricalMarketRecord[],
  ): Promise<number> {
    if (candidates.length < 1 || candidates.length > 5000)
      throw new Error("historical market batch must contain between 1 and 5000 records");
    const records = candidates.map((candidate) => ({
      ...candidate,
      event: MarketEventSchema.parse(candidate.event),
    }));
    return this.#database.transaction(async (transaction) => {
      let inserted = 0;
      for (const record of records) {
        const rawRef = contentHash(record.payload);
        if (rawRef !== record.event.rawRef)
          throw new Error("raw backfill provenance hash mismatch");
        await persistRawObject(transaction, rawRef, record.payload, record.event.ingestTime);
        await transaction.query(
          `INSERT INTO raw_public_market_messages
            (raw_ref, source, venue, product_id, message_type, sequence, observed_at, ingested_at,
             payload, raw_object_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) ON CONFLICT (raw_ref) DO NOTHING`,
          [
            rawRef,
            record.event.source,
            record.event.venue,
            record.productId,
            record.messageType,
            record.event.bookSequence ?? null,
            record.event.eventTime,
            record.event.ingestTime,
            JSON.stringify({ rawObjectRef: rawRef }),
            rawRef,
          ],
        );
        const result = await transaction.query(
          `INSERT INTO canonical_market_events
            (event_id, event_time, ingest_time, source, venue, instrument_id, event_type,
             price, quantity, side, bid, ask, book_sequence, raw_ref, schema_version, record_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (event_id) DO NOTHING`,
          [
            record.event.eventId,
            record.event.eventTime,
            record.event.ingestTime,
            record.event.source,
            record.event.venue,
            record.event.instrumentId,
            record.event.eventType,
            record.event.price ?? null,
            record.event.quantity ?? null,
            record.event.side ?? null,
            record.event.bid ?? null,
            record.event.ask ?? null,
            record.event.bookSequence ?? null,
            record.event.rawRef,
            Number(record.event.schemaVersion),
            contentHash(record.event),
          ],
        );
        if ((result.affectedRows ?? 0) > 0) inserted += 1;
      }
      return inserted;
    });
  }

  public async persistRawMarketMessage(input: {
    readonly source: string;
    readonly venue: string;
    readonly productId?: string;
    readonly messageType: string;
    readonly sequence?: string;
    readonly observedAt?: string;
    readonly ingestedAt: string;
    readonly payload: unknown;
  }): Promise<{ readonly rawRef: `sha256:${string}`; readonly inserted: boolean }> {
    const rawRef = contentHash(input.payload);
    return this.#database.transaction(async (transaction) => {
      await persistRawObject(transaction, rawRef, input.payload, input.ingestedAt);
      const result = await transaction.query(
        `INSERT INTO raw_public_market_messages
          (raw_ref, source, venue, product_id, message_type, sequence, observed_at, ingested_at,
           payload, raw_object_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) ON CONFLICT (raw_ref) DO NOTHING`,
        [
          rawRef,
          input.source,
          input.venue,
          input.productId ?? null,
          input.messageType,
          input.sequence ?? null,
          input.observedAt ?? null,
          input.ingestedAt,
          JSON.stringify({ rawObjectRef: rawRef }),
          rawRef,
        ],
      );
      return { rawRef, inserted: (result.affectedRows ?? 0) > 0 };
    });
  }

  public async rawObject(rawRef: `sha256:${string}`): Promise<unknown> {
    const result = await this.#database.query<{
      encoding: string;
      payload: Uint8Array;
      uncompressed_bytes: string | number;
    }>(
      `SELECT encoding, payload, uncompressed_bytes
       FROM raw_objects WHERE object_hash = $1`,
      [rawRef],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.encoding !== "GZIP_JSON_V1") throw new Error("unsupported raw-object encoding");
    const exact = gunzipSync(Buffer.from(row.payload)).toString("utf8");
    if (Buffer.byteLength(exact, "utf8") !== Number(row.uncompressed_bytes))
      throw new Error("raw-object length mismatch");
    const value = JSON.parse(exact) as unknown;
    if (contentHash(value) !== rawRef) throw new Error("raw-object content hash mismatch");
    return value;
  }

  public async latestReferencePriceData(
    instruments: readonly ReferenceInstrumentDescriptor[],
    basisInstrument: ReferenceInstrumentDescriptor,
    asOf: string,
  ): Promise<{
    readonly observations: readonly ReferencePriceObservation[];
    readonly basis?: QuoteBasisObservation;
  }> {
    const observations: ReferencePriceObservation[] = [];
    for (const instrument of instruments) {
      const trade = await this.#database.query<{
        event_time: Date | string;
        price: string;
        raw_ref: `sha256:${string}`;
      }>(
        `SELECT event_time, price, raw_ref FROM canonical_market_events
         WHERE venue = $1 AND instrument_id = $2 AND event_type = 'TRADE'
           AND price IS NOT NULL AND event_time <= $3
         ORDER BY event_time DESC, event_id DESC LIMIT 1`,
        [instrument.venue, instrument.instrumentId, asOf],
      );
      const latestTrade = trade.rows[0];
      if (latestTrade)
        observations.push({
          ...instrument,
          kind: "TRADE",
          price: latestTrade.price,
          observedAt: toIsoTimestamp(latestTrade.event_time),
          evidenceRef: latestTrade.raw_ref,
        });
      const snapshot = await this.#database.query<{
        observed_at: Date | string;
        bids: unknown;
        asks: unknown;
        content_hash: `sha256:${string}`;
      }>(
        `SELECT observed_at, bids, asks, content_hash FROM order_book_snapshots
         WHERE venue = $1 AND instrument_id = $2 AND observed_at <= $3
         ORDER BY observed_at DESC, sequence DESC LIMIT 1`,
        [instrument.venue, instrument.instrumentId, asOf],
      );
      const latestBook = snapshot.rows[0];
      if (latestBook) {
        const level = (candidate: unknown): string | undefined => {
          if (!Array.isArray(candidate)) throw new Error("stored order-book side is not an array");
          const first: unknown = candidate[0];
          if (!first || typeof first !== "object") return undefined;
          const price = (first as { readonly price?: unknown }).price;
          if (typeof price !== "string") throw new Error("stored order-book level has no price");
          return price;
        };
        const bid = level(latestBook.bids);
        const ask = level(latestBook.asks);
        if (bid && ask)
          observations.push({
            ...instrument,
            kind: "BOOK",
            price: new Decimal(bid).plus(ask).div(2).toString(),
            bid,
            ask,
            observedAt: toIsoTimestamp(latestBook.observed_at),
            evidenceRef: latestBook.content_hash,
          });
      }
    }
    const basisResult = await this.#database.query<{
      event_time: Date | string;
      price: string;
      raw_ref: `sha256:${string}`;
    }>(
      `SELECT event_time, price, raw_ref FROM canonical_market_events
       WHERE venue = $1 AND instrument_id = $2 AND event_type = 'TRADE'
         AND price IS NOT NULL AND event_time <= $3
       ORDER BY event_time DESC, event_id DESC LIMIT 1`,
      [basisInstrument.venue, basisInstrument.instrumentId, asOf],
    );
    const basisRow = basisResult.rows[0];
    return {
      observations,
      ...(basisRow
        ? {
            basis: {
              quoteAsset: "USDT" as const,
              usdPerQuote: basisRow.price,
              observedAt: toIsoTimestamp(basisRow.event_time),
              evidenceRef: basisRow.raw_ref,
            },
          }
        : {}),
    };
  }

  public async computeAndPersistReferencePrice(
    instruments: readonly ReferenceInstrumentDescriptor[],
    basisInstrument: ReferenceInstrumentDescriptor,
    config: ReferencePriceConfig,
    options: { readonly persistWithheld?: boolean } = {},
  ): Promise<ReferencePriceEstimate> {
    const data = await this.latestReferencePriceData(instruments, basisInstrument, config.asOf);
    const estimate = computeReferencePrice(data.observations, data.basis, config);
    const { contentHash: estimateHash, ...hashInput } = estimate;
    if (contentHash(hashInput) !== estimateHash)
      throw new Error("reference-price estimate content hash mismatch");
    const snapshotId = deterministicDomainId(
      "reference",
      `${estimate.baseAsset}:${estimate.asOf}:${estimate.configHash}`,
    );
    if (estimate.status === "PUBLISHED" || options.persistWithheld !== false)
      await this.#database.query(
        `INSERT INTO reference_price_snapshots
        (snapshot_id, algorithm_version, base_asset, quote_asset, as_of, status, price,
         confidence_low, confidence_high, uncertainty_bps, quality_score, evidence_refs,
         config_hash, estimate, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15)
       ON CONFLICT (snapshot_id) DO NOTHING`,
        [
          snapshotId,
          Number(estimate.algorithmVersion),
          estimate.baseAsset,
          estimate.quoteAsset,
          estimate.asOf,
          estimate.status,
          estimate.price,
          estimate.confidenceLow,
          estimate.confidenceHigh,
          estimate.uncertaintyBps,
          estimate.qualityScore,
          JSON.stringify(estimate.evidenceRefs),
          estimate.configHash,
          JSON.stringify(estimate),
          estimate.contentHash,
        ],
      );
    return estimate;
  }

  public async computeAndPersistMarketRegime(input: {
    readonly asOf: string;
    readonly windowSeconds?: number;
    readonly minimumSamples?: number;
    readonly directionThresholdPct?: number;
    readonly volatilityThresholdPct?: number;
  }): Promise<MarketRegimeResult> {
    const windowSeconds = input.windowSeconds ?? 3600;
    const minimumSamples = input.minimumSamples ?? 12;
    const directionThresholdPct = input.directionThresholdPct ?? 0.25;
    const volatilityThresholdPct = input.volatilityThresholdPct ?? 0.15;
    const cutoff = new Date(new Date(input.asOf).getTime() - windowSeconds * 1000);
    if (Number.isNaN(cutoff.getTime())) throw new Error("invalid regime cutoff");
    const prices = await this.#database.query<{
      snapshot_id: string;
      as_of: Date | string;
      price: string;
    }>(
      `SELECT snapshot_id, as_of, price::text
       FROM reference_price_snapshots
       WHERE status = 'PUBLISHED' AND base_asset = 'SOL' AND quote_asset = 'USD'
         AND as_of >= $1 AND as_of <= $2
       ORDER BY as_of, snapshot_id`,
      [cutoff.toISOString(), input.asOf],
    );
    const result = classifyMarketRegime({
      observations: prices.rows.map((row) => ({
        observedAt: toIsoTimestamp(row.as_of),
        price: Number(row.price),
        evidenceRef: row.snapshot_id,
      })),
      asOf: input.asOf,
      windowSeconds,
      minimumSamples,
      directionThresholdPct,
      volatilityThresholdPct,
    });
    const identity = { ...result, algorithmVersion: 1 };
    const recordHash = contentHash(identity);
    const regimeId = deterministicDomainId(
      "regime",
      `${result.asOf}:${String(result.windowSeconds)}:${result.configHash}`,
    );
    const inserted = await this.#database.query(
      `INSERT INTO market_regime_snapshots
        (regime_id, as_of, window_seconds, state, sample_size, return_pct,
         realized_volatility_pct, evidence_refs, config_hash, result, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11)
       ON CONFLICT (regime_id) DO NOTHING`,
      [
        regimeId,
        result.asOf,
        result.windowSeconds,
        result.state,
        result.sampleSize,
        result.returnPct,
        result.realizedVolatilityPct,
        JSON.stringify(result.evidenceRefs),
        result.configHash,
        JSON.stringify(result),
        recordHash,
      ],
    );
    if ((inserted.affectedRows ?? 0) === 0) {
      const existing = await this.#database.query<{ content_hash: string }>(
        "SELECT content_hash FROM market_regime_snapshots WHERE regime_id = $1",
        [regimeId],
      );
      if (existing.rows[0]?.content_hash !== recordHash)
        throw new Error(`market-regime identity collision: ${regimeId}`);
    }
    return result;
  }

  public async materializeCapitalFlowEpisodes(input: {
    readonly asOf: string;
    readonly windowSeconds?: number;
    readonly finalizationGraceSeconds?: number;
    readonly maximumWindows?: number;
  }): Promise<{ readonly episodesInserted: number; readonly eventsGrouped: number }> {
    const windowSeconds = input.windowSeconds ?? 30;
    const finalizationGraceSeconds = input.finalizationGraceSeconds ?? 120;
    const maximumWindows = input.maximumWindows ?? 20;
    if (!Number.isInteger(windowSeconds) || windowSeconds < 10 || windowSeconds > 3600)
      throw new Error("episode window must be between 10 and 3600 seconds");
    if (
      !Number.isInteger(finalizationGraceSeconds) ||
      finalizationGraceSeconds < windowSeconds ||
      finalizationGraceSeconds > 86_400
    )
      throw new Error("episode finalization grace must be between one window and one day");
    if (!Number.isInteger(maximumWindows) || maximumWindows < 1 || maximumWindows > 1000)
      throw new Error("maximum episode windows must be between 1 and 1000");
    const asOfMs = new Date(input.asOf).getTime();
    if (!Number.isFinite(asOfMs)) throw new Error("invalid episode as-of timestamp");
    const closedBefore = new Date(asOfMs - finalizationGraceSeconds * 1000).toISOString();
    const nativeSolAssetId = deterministicDomainId("asset", "solana:native:SOL");
    const rows = await this.#database.query<{
      event_id: string;
      event_time: Date | string;
      quantity: string;
      from_entity_id: string;
      to_entity_id: string;
      from_type: string;
      to_type: string;
      venue_label: string | null;
      venue_retrieved_at: Date | string | null;
      from_evidence_hash: string | null;
      to_evidence_hash: string | null;
      venue_evidence_hash: string | null;
      raw_ref: string;
    }>(
      `SELECT event.event_id, event.event_time, event.quantity::text,
              event.from_entity_id, event.to_entity_id, event.raw_ref,
              COALESCE(from_attribution.entity_type, 'UNKNOWN') AS from_type,
              COALESCE(to_attribution.entity_type, 'UNKNOWN') AS to_type,
              venue_attribution.label AS venue_label,
              venue_attribution.retrieved_at AS venue_retrieved_at,
              from_attribution.evidence_hash AS from_evidence_hash,
              to_attribution.evidence_hash AS to_evidence_hash,
              venue_attribution.evidence_hash AS venue_evidence_hash
       FROM capital_events event
       LEFT JOIN LATERAL (
         SELECT verified.entity_type, verified.evidence_hash
         FROM entity_addresses address
         JOIN verified_entity_addresses verified ON verified.address = address.address
         WHERE address.entity_id = event.from_entity_id
           AND verified.retrieved_at <= event.event_time
           AND verified.valid_from <= event.event_time
           AND (verified.valid_to IS NULL OR verified.valid_to >= event.event_time)
         ORDER BY verified.valid_from DESC LIMIT 1
       ) from_attribution ON true
       LEFT JOIN LATERAL (
         SELECT verified.entity_type, verified.evidence_hash
         FROM entity_addresses address
         JOIN verified_entity_addresses verified ON verified.address = address.address
         WHERE address.entity_id = event.to_entity_id
           AND verified.retrieved_at <= event.event_time
           AND verified.valid_from <= event.event_time
           AND (verified.valid_to IS NULL OR verified.valid_to >= event.event_time)
         ORDER BY verified.valid_from DESC LIMIT 1
       ) to_attribution ON true
       LEFT JOIN LATERAL (
         SELECT verified.label, verified.retrieved_at, verified.evidence_hash
         FROM verified_entity_addresses verified
         WHERE verified.address = event.venue
           AND verified.retrieved_at <= event.event_time
           AND verified.valid_from <= event.event_time
           AND (verified.valid_to IS NULL OR verified.valid_to >= event.event_time)
         ORDER BY verified.valid_from DESC LIMIT 1
       ) venue_attribution ON true
       WHERE event.asset_id = $1 AND event.event_time <= $2
         AND event.from_entity_id IS NOT NULL AND event.to_entity_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM capital_flow_episode_events link
           JOIN capital_flow_episodes episode ON episode.episode_id = link.episode_id
           WHERE link.event_id = event.event_id AND episode.algorithm_version = 2
         )
       ORDER BY event.event_time DESC, event.event_id DESC LIMIT $3`,
      [nativeSolAssetId, closedBefore, maximumWindows * 100],
    );
    const entityClass = (value: string): EpisodeEntityClass => {
      if (value === "EXCHANGE") return "CEX";
      if (value === "BRIDGE") return "BRIDGE";
      if (value === "POOL") return "POOL";
      if (value === "PROTOCOL" || value === "CONTRACT") return "PROTOCOL";
      return "UNKNOWN";
    };
    const configuration = {
      ...defaultEpisodeConstructionConfig,
      maximumTemporalSeparationSeconds: windowSeconds,
    };
    const episodes = constructCapitalFlowEpisodes(
      rows.rows.map((event) => ({
        eventId: event.event_id,
        eventTime: toIsoTimestamp(event.event_time),
        assetId: nativeSolAssetId,
        quantity: event.quantity,
        sourceEntityId: event.from_entity_id,
        destinationEntityId: event.to_entity_id,
        sourceClass: entityClass(event.from_type),
        destinationClass: entityClass(event.to_type),
        ...(event.venue_label === null ? {} : { protocolId: event.venue_label }),
        ...(event.venue_retrieved_at === null
          ? {}
          : { protocolVerifiedAt: toIsoTimestamp(event.venue_retrieved_at) }),
        attributionAsOf: toIsoTimestamp(event.event_time),
        attributionEvidenceIds: [
          event.raw_ref,
          event.from_evidence_hash,
          event.to_evidence_hash,
          event.venue_evidence_hash,
        ].filter((value): value is string => value !== null),
        transactionSucceeded: true,
        attributionAmbiguous: false,
      })),
      configuration,
    ).slice(-maximumWindows);
    await this.#database.query(
      `INSERT INTO capital_flow_episode_algorithms
        (algorithm_version, configuration, config_hash, registered_at, code_revision, description)
       VALUES (2,$1::jsonb,$2,$3,$4,$5) ON CONFLICT (algorithm_version) DO NOTHING`,
      [
        JSON.stringify(configuration),
        contentHash(configuration),
        input.asOf,
        process.env.CFIE_CODE_REVISION ?? "WORKTREE_UNCOMMITTED",
        "Directed entity-pair episodes; temporal proximity alone is insufficient.",
      ],
    );
    let episodesInserted = 0;
    let eventsGrouped = 0;
    for (const episode of episodes) {
      const windowEnd =
        episode.end === episode.start
          ? new Date(new Date(episode.start).getTime() + 1).toISOString()
          : episode.end;
      const inserted = await this.#database.transaction(async (transaction) => {
        const result = await transaction.query(
          `INSERT INTO capital_flow_episodes
            (episode_id, asset_id, window_start, window_end, anchor_event_id, event_count,
             total_quantity, maximum_quantity, dominant_cohort, cohort_quantities,
             from_entity_types, to_entity_types, venue_labels, finalized_at,
             algorithm_version, content_hash, config_hash, source_entity_id,
             destination_entity_id, direction, attribution_as_of, attribution_evidence, quality)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14,
                   2,$15,$16,$17,$18,$19,$20,$21::jsonb,$22)
           ON CONFLICT (episode_id) DO NOTHING`,
          [
            episode.episodeId,
            episode.assetId,
            episode.start,
            windowEnd,
            episode.anchorEventId,
            episode.eventCount,
            episode.totalQuantity,
            episode.maximumQuantity,
            episode.direction,
            JSON.stringify({ [episode.direction]: episode.totalQuantity }),
            JSON.stringify([episode.sourceClass]),
            JSON.stringify([episode.destinationClass]),
            JSON.stringify(episode.protocolId ? [episode.protocolId] : []),
            input.asOf,
            episode.contentHash,
            episode.configHash,
            episode.sourceEntityId,
            episode.destinationEntityId,
            episode.direction,
            episode.attributionAsOf,
            JSON.stringify(episode.attributionEvidenceIds),
            episode.quality,
          ],
        );
        if ((result.affectedRows ?? 0) === 0) return false;
        for (const [ordinal, eventId] of episode.memberEventIds.entries())
          await transaction.query(
            `INSERT INTO capital_flow_episode_events (episode_id, event_id, event_ordinal)
             VALUES ($1,$2,$3)`,
            [episode.episodeId, eventId, ordinal],
          );
        return true;
      });
      if (inserted) {
        episodesInserted += 1;
        eventsGrouped += episode.eventCount;
      }
    }
    return { episodesInserted, eventsGrouped };
  }

  public async materializeEpisodeProtocolContexts(input: {
    readonly asOf: string;
    readonly maximumEpisodes?: number;
  }): Promise<{ readonly contextsInserted: number; readonly verifiedEvents: number }> {
    const maximumEpisodes = input.maximumEpisodes ?? 100;
    if (!Number.isInteger(maximumEpisodes) || maximumEpisodes < 1 || maximumEpisodes > 1000)
      throw new Error("maximum context episodes must be between 1 and 1000");
    const candidates = await this.#database.query<{
      episode_id: string;
      algorithm_version: number;
    }>(
      `SELECT episode.episode_id, episode.algorithm_version
       FROM capital_flow_episodes episode
       WHERE NOT EXISTS (
         SELECT 1 FROM capital_flow_episode_protocol_contexts context
         WHERE context.episode_id = episode.episode_id
           AND context.algorithm_version = episode.algorithm_version
       )
       ORDER BY episode.window_start DESC, episode.episode_id DESC LIMIT $1`,
      [maximumEpisodes],
    );
    if (candidates.rows.length === 0) return { contextsInserted: 0, verifiedEvents: 0 };
    const episodeIds = candidates.rows.map((row) => row.episode_id);
    const versionByEpisode = new Map(
      candidates.rows.map((row) => [row.episode_id, row.algorithm_version]),
    );
    const contexts = await this.#database.query<{
      episode_id: string;
      label: string;
      entity_type: string;
      event_count: string | number;
    }>(
      `SELECT link.episode_id, verified.label, verified.entity_type, count(*) AS event_count
       FROM capital_flow_episode_events link
       JOIN capital_events event ON event.event_id = link.event_id
       JOIN verified_entity_addresses verified ON verified.address = event.venue
       WHERE link.episode_id = ANY($1::text[])
         AND verified.retrieved_at <= event.event_time
         AND verified.valid_from <= event.event_time
         AND (verified.valid_to IS NULL OR verified.valid_to >= event.event_time)
       GROUP BY link.episode_id, verified.label, verified.entity_type
       ORDER BY link.episode_id, count(*) DESC, verified.label`,
      [episodeIds],
    );
    const byEpisode = new Map<
      string,
      { readonly label: string; readonly entityType: string; readonly eventCount: number }[]
    >();
    for (const row of contexts.rows) {
      const current = byEpisode.get(row.episode_id) ?? [];
      current.push({
        label: row.label,
        entityType: row.entity_type,
        eventCount: Number(row.event_count),
      });
      byEpisode.set(row.episode_id, current);
    }
    let contextsInserted = 0;
    let verifiedEvents = 0;
    for (const episodeId of episodeIds) {
      const algorithmVersion = versionByEpisode.get(episodeId);
      if (algorithmVersion === undefined) throw new Error("episode algorithm version is missing");
      const venues = byEpisode.get(episodeId) ?? [];
      const verifiedEventCount = venues.reduce((sum, venue) => sum + venue.eventCount, 0);
      const primary = venues[0];
      const identity = {
        episodeId,
        algorithmVersion,
        verifiedEventCount,
        primaryVenueLabel: primary?.label ?? null,
        primaryVenueEntityType: primary?.entityType ?? null,
        venueCounts: Object.fromEntries(venues.map((venue) => [venue.label, venue.eventCount])),
      };
      const inserted = await this.#database.query(
        `INSERT INTO capital_flow_episode_protocol_contexts
          (episode_id, algorithm_version, verified_event_count, primary_venue_label,
           primary_venue_entity_type, venue_counts, computed_at, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
         ON CONFLICT (episode_id, algorithm_version) DO NOTHING`,
        [
          episodeId,
          algorithmVersion,
          verifiedEventCount,
          identity.primaryVenueLabel,
          identity.primaryVenueEntityType,
          JSON.stringify(identity.venueCounts),
          input.asOf,
          contentHash(identity),
        ],
      );
      if ((inserted.affectedRows ?? 0) > 0) {
        contextsInserted += 1;
        verifiedEvents += verifiedEventCount;
      }
    }
    return { contextsInserted, verifiedEvents };
  }

  public async persistOrderBookSnapshot(snapshot: {
    readonly venue: string;
    readonly instrumentId: string;
    readonly sequence: string;
    readonly observedAt: string;
    readonly bids: readonly { readonly price: string; readonly size: string }[];
    readonly asks: readonly { readonly price: string; readonly size: string }[];
    readonly inputRefs: readonly string[];
  }): Promise<boolean> {
    const identity = { ...snapshot, algorithmVersion: 1 };
    const result = await this.#database.query(
      `INSERT INTO order_book_snapshots
        (venue, instrument_id, sequence, observed_at, bids, asks, algorithm_version,
         input_refs, content_hash)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,1,$7::jsonb,$8)
       ON CONFLICT (venue, instrument_id, sequence) DO NOTHING`,
      [
        snapshot.venue,
        snapshot.instrumentId,
        snapshot.sequence,
        snapshot.observedAt,
        JSON.stringify(snapshot.bids),
        JSON.stringify(snapshot.asks),
        JSON.stringify(snapshot.inputRefs),
        contentHash(identity),
      ],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  public async computeAndPersistMarketReaction(input: {
    readonly capitalEventId: string;
    readonly venue: string;
    readonly instrumentId: string;
    readonly windowSeconds: number;
    readonly depthLevels?: number;
    readonly maximumSnapshotAgeSeconds?: number;
    readonly maximumTrades?: number;
  }): Promise<PersistedMarketReaction> {
    const allowedWindows = new Set([60, 300, 900, 3600, 21_600, 86_400]);
    if (!allowedWindows.has(input.windowSeconds))
      throw new Error("market-reaction window must match a registered research horizon");
    const maximumSnapshotAgeSeconds = input.maximumSnapshotAgeSeconds ?? 60;
    const maximumTrades = input.maximumTrades ?? 100_000;
    if (
      !Number.isInteger(maximumSnapshotAgeSeconds) ||
      maximumSnapshotAgeSeconds < 1 ||
      maximumSnapshotAgeSeconds > 3600
    )
      throw new Error("maximum snapshot age must be between 1 and 3600 seconds");
    if (!Number.isInteger(maximumTrades) || maximumTrades < 1 || maximumTrades > 100_000)
      throw new Error("maximum trades must be between 1 and 100000");
    const event = await this.capitalEvent(input.capitalEventId);
    if (!event) throw new Error(`capital event not found: ${input.capitalEventId}`);
    const eventMs = new Date(event.eventTime).getTime();
    const windowEnd = new Date(eventMs + input.windowSeconds * 1000).toISOString();
    const beforeFloor = new Date(eventMs - maximumSnapshotAgeSeconds * 1000).toISOString();
    const snapshotRows = async (
      predicate: string,
      parameters: readonly unknown[],
      order: string,
    ): Promise<{
      sequence: string | number;
      observed_at: Date | string;
      bids: OrderBookSnapshot["bids"];
      asks: OrderBookSnapshot["asks"];
      content_hash: `sha256:${string}`;
    }> => {
      const result = await this.#database.query<{
        sequence: string | number;
        observed_at: Date | string;
        bids: OrderBookSnapshot["bids"];
        asks: OrderBookSnapshot["asks"];
        content_hash: `sha256:${string}`;
      }>(
        `SELECT sequence::text, observed_at, bids, asks, content_hash
         FROM order_book_snapshots
         WHERE venue = $1 AND instrument_id = $2 AND ${predicate}
         ORDER BY observed_at ${order}, sequence ${order} LIMIT 1`,
        parameters,
      );
      const row = result.rows[0];
      if (!row) throw new Error("required point-in-time order-book snapshot is unavailable");
      return row;
    };
    const [beforeRow, afterRow, tradeRows, incidentRows] = await Promise.all([
      snapshotRows(
        "observed_at >= $3 AND observed_at <= $4",
        [input.venue, input.instrumentId, beforeFloor, event.eventTime],
        "DESC",
      ),
      snapshotRows(
        "observed_at >= $3 AND observed_at <= $4",
        [input.venue, input.instrumentId, event.eventTime, windowEnd],
        "DESC",
      ),
      this.#database.query<{
        event_id: string;
        event_time: Date | string;
        side: "BUY" | "SELL";
        price: string;
        quantity: string;
      }>(
        `SELECT event_id, event_time, side, price::text, quantity::text
         FROM canonical_market_events
         WHERE venue = $1 AND instrument_id = $2 AND event_type = 'TRADE'
           AND event_time >= $3 AND event_time <= $4
           AND side IS NOT NULL AND price IS NOT NULL AND quantity IS NOT NULL
         ORDER BY event_time, event_id LIMIT $5`,
        [input.venue, input.instrumentId, event.eventTime, windowEnd, maximumTrades + 1],
      ),
      this.#database.query<{ count: string | number }>(
        `SELECT count(*) AS count FROM market_data_incidents
         WHERE venue = $1 AND detected_at >= $2 AND detected_at <= $3`,
        [input.venue, event.eventTime, windowEnd],
      ),
    ]);
    if (Number(incidentRows.rows[0]?.count ?? 0) > 0)
      throw new Error("market-reaction window overlaps a market-data incident");
    if (tradeRows.rows.length > maximumTrades)
      throw new Error("market-reaction trade window exceeds the bounded processing limit");
    const book = (row: typeof beforeRow): OrderBookSnapshot => ({
      sequence: String(row.sequence),
      bids: row.bids,
      asks: row.asks,
    });
    const trades: TimedTrade[] = tradeRows.rows.map((row) => ({
      eventId: row.event_id,
      eventTime: toIsoTimestamp(row.event_time),
      side: row.side,
      price: row.price,
      quantity: row.quantity,
    }));
    const features = computeMarketReactionFeatures({
      before: book(beforeRow),
      after: book(afterRow),
      trades,
      ...(input.depthLevels === undefined ? {} : { depthLevels: input.depthLevels }),
    });
    const identity = {
      capitalEventId: input.capitalEventId,
      venue: input.venue,
      instrumentId: input.instrumentId,
      windowSeconds: input.windowSeconds,
      windowStart: event.eventTime,
      windowEnd,
      beforeSnapshotHash: beforeRow.content_hash,
      afterSnapshotHash: afterRow.content_hash,
      algorithmVersion: 1 as const,
      features,
    };
    const record: PersistedMarketReaction = {
      featureId: deterministicDomainId(
        "market_reaction",
        `${input.capitalEventId}:${input.venue}:${input.instrumentId}:${String(input.windowSeconds)}:1`,
      ),
      ...identity,
      contentHash: contentHash(identity),
    };
    const inserted = await this.#database.query(
      `INSERT INTO capital_event_market_reactions
        (feature_id, capital_event_id, venue, instrument_id, window_seconds, window_start,
         window_end, before_snapshot_hash, after_snapshot_hash, algorithm_version,
         features, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10::jsonb,$11)
       ON CONFLICT (feature_id) DO NOTHING`,
      [
        record.featureId,
        record.capitalEventId,
        record.venue,
        record.instrumentId,
        record.windowSeconds,
        record.windowStart,
        record.windowEnd,
        record.beforeSnapshotHash,
        record.afterSnapshotHash,
        JSON.stringify(record.features),
        record.contentHash,
      ],
    );
    if ((inserted.affectedRows ?? 0) === 0) {
      const existing = await this.#database.query<{ content_hash: string }>(
        "SELECT content_hash FROM capital_event_market_reactions WHERE feature_id = $1",
        [record.featureId],
      );
      if (existing.rows[0]?.content_hash !== record.contentHash)
        throw new Error(`market-reaction identity collision: ${record.featureId}`);
    }
    return record;
  }

  public async pendingMarketReactionEventIds(input: {
    readonly venue: string;
    readonly instrumentId: string;
    readonly windowSeconds: number;
    readonly asOf: string;
    readonly maximumEvents: number;
    readonly maximumSnapshotAgeSeconds?: number;
  }): Promise<readonly string[]> {
    if (
      !Number.isInteger(input.maximumEvents) ||
      input.maximumEvents < 1 ||
      input.maximumEvents > 10_000
    )
      throw new Error("maximum events must be between 1 and 10000");
    const cutoff = new Date(new Date(input.asOf).getTime() - input.windowSeconds * 1000);
    if (Number.isNaN(cutoff.getTime())) throw new Error("invalid market-reaction as-of time");
    const nativeSolAssetId = deterministicDomainId("asset", "solana:native:SOL");
    const maximumSnapshotAgeSeconds = input.maximumSnapshotAgeSeconds ?? 60;
    if (
      !Number.isInteger(maximumSnapshotAgeSeconds) ||
      maximumSnapshotAgeSeconds < 1 ||
      maximumSnapshotAgeSeconds > 3600
    )
      throw new Error("maximum snapshot age must be between 1 and 3600 seconds");
    const result = await this.#database.query<{ event_id: string }>(
      `SELECT event.event_id
       FROM capital_events event
       WHERE event.asset_id = $1 AND event.event_time <= $2
         AND EXISTS (
           SELECT 1 FROM capital_event_forward_outcomes outcome
           WHERE outcome.event_id = event.event_id
             AND outcome.horizon = CASE $5::integer
               WHEN 60 THEN '1m' WHEN 300 THEN '5m' WHEN 900 THEN '15m'
               WHEN 3600 THEN '1h' WHEN 21600 THEN '6h' WHEN 86400 THEN '24h' END
         )
         AND NOT EXISTS (
           SELECT 1 FROM capital_event_market_reactions reaction
           WHERE reaction.capital_event_id = event.event_id
             AND reaction.venue = $3 AND reaction.instrument_id = $4
             AND reaction.window_seconds = $5 AND reaction.algorithm_version = 1
         )
         AND EXISTS (
           SELECT 1 FROM order_book_snapshots before_book
           WHERE before_book.venue = $3 AND before_book.instrument_id = $4
             AND before_book.observed_at <= event.event_time
             AND before_book.observed_at >= event.event_time - ($7 * interval '1 second')
         )
         AND EXISTS (
           SELECT 1 FROM order_book_snapshots after_book
           WHERE after_book.venue = $3 AND after_book.instrument_id = $4
             AND after_book.observed_at >= event.event_time
             AND after_book.observed_at <= event.event_time + ($5 * interval '1 second')
         )
         AND NOT EXISTS (
           SELECT 1 FROM market_data_incidents incident
           WHERE incident.venue = $3
             AND incident.detected_at >= event.event_time
             AND incident.detected_at <= event.event_time + ($5 * interval '1 second')
         )
       ORDER BY event.event_time DESC, event.event_id DESC
       LIMIT $6`,
      [
        nativeSolAssetId,
        cutoff.toISOString(),
        input.venue,
        input.instrumentId,
        input.windowSeconds,
        input.maximumEvents,
        maximumSnapshotAgeSeconds,
      ],
    );
    return result.rows.map((row) => row.event_id);
  }

  public async persistEvidencePacket(candidate: EvidencePacket): Promise<void> {
    const packet = EvidencePacketSchema.parse(candidate);
    await this.#database.query(
      `INSERT INTO evidence_packets
        (packet_id, packet_version, detected_event_id, generated_at, packet, content_hash)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (packet_id) DO NOTHING`,
      [
        packet.packetId,
        Number(packet.packetVersion),
        packet.detectedEvent.eventId,
        packet.generatedAt,
        JSON.stringify(packet),
        packet.contentHash,
      ],
    );
  }

  public async evidencePacket(packetId: string): Promise<EvidencePacket | undefined> {
    const result = await this.#database.query<{ packet: unknown }>(
      "SELECT packet FROM evidence_packets WHERE packet_id = $1",
      [packetId],
    );
    const row = result.rows[0];
    return row ? EvidencePacketSchema.parse(row.packet) : undefined;
  }
}
