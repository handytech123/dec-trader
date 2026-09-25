import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { Decimal } from "decimal.js";
import { computeMarketFeaturesV1, type MarketPoint } from "@autonomous-trading-lab/market-research";
import type { CaptureFailure } from "./capture.js";
import type { RpcMintAssessment } from "./solana-rpc.js";
import type { RouteAssessment } from "./jupiter.js";
import type { MarketIntegrityAssessment } from "./jupiter-token.js";
import { deterministicDomainId } from "./ids.js";
import type { CaptureRecord } from "./schemas.js";

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

export class ResearchDatabase {
  readonly #database: PGlite;

  public constructor(dataDirectory: string) {
    this.#database = new PGlite(dataDirectory);
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
      await this.#database.exec(sql);
      await this.#database.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
        name,
        checksum,
      ]);
    }
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

  async #persistRecord(transaction: Transaction, record: CaptureRecord): Promise<void> {
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

  public async close(): Promise<void> {
    await this.#database.close();
  }
}
