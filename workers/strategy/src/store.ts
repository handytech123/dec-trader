import {
  contentHash,
  deterministicDomainId,
  type EvaluationMode,
} from "@autonomous-trading-lab/domain";
import { createSqlDatabase, type SqlDatabase } from "@autonomous-trading-lab/ingestion";
import type {
  ReadonlyFeatureSnapshot,
  StrategyProposalEvaluation,
} from "@autonomous-trading-lab/strategy-sdk";
import { buildCfieResearchFeatures } from "./research-snapshot.js";
import { bindStrategyFindingPacket } from "./research-evidence.js";

export type StrategyStatus = "RESEARCH_ONLY" | "SHADOW_ELIGIBLE" | "PAPER_ELIGIBLE" | "RETIRED";

export interface StrategyJob {
  readonly jobId: string;
  readonly snapshotId: string;
  readonly evaluationId: string;
  readonly strategyVersionId: string;
  readonly strategyStatus: StrategyStatus;
  readonly moduleKey: string;
  readonly observedAt: string;
  readonly asOfSlot: string | null;
  readonly mode: Exclude<EvaluationMode, "LIVE">;
  readonly portfolioSnapshotId: string;
  readonly featureSnapshotId: string;
  readonly features: ReadonlyFeatureSnapshot;
  readonly provenance: Readonly<Record<string, unknown>>;
}

export interface StrategyStore {
  claimJobs(ownerId: string, limit: number, leaseMs: number): Promise<readonly StrategyJob[]>;
  completeJob(job: StrategyJob, ownerId: string, result: StrategyProposalEvaluation): Promise<void>;
  failJob(jobId: string, ownerId: string, error: string): Promise<void>;
}

export interface StrategyDefinitionInput {
  readonly strategyId: string;
  readonly version: string;
  readonly status: StrategyStatus;
  readonly moduleKey: string;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly registeredAt: string;
}

export interface StrategySnapshotInput {
  readonly featureSnapshotId: string;
  readonly portfolioSnapshotId: string;
  readonly observedAt: string;
  readonly asOfSlot?: string;
  readonly mode: Exclude<EvaluationMode, "LIVE">;
  readonly features: ReadonlyFeatureSnapshot;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly strategyVersionIds: readonly string[];
}

export interface StrategyServiceStatus {
  readonly pending: number;
  readonly processing: number;
  readonly complete: number;
  readonly failed: number;
  readonly evaluations: number;
  readonly proposals: number;
}

export interface StrategyComparisonRow {
  readonly strategyId: string;
  readonly version: string;
  readonly status: StrategyStatus;
  readonly evaluations: number;
  readonly proposals: number;
  readonly noTrades: number;
  readonly latestEvaluationAt: string | null;
}

export class PostgresStrategyStore implements StrategyStore {
  readonly #database: SqlDatabase;

  public constructor(location: string) {
    this.#database = createSqlDatabase(location);
  }

  public async registerStrategy(input: StrategyDefinitionInput): Promise<string> {
    if (!input.strategyId || !input.version || !input.moduleKey)
      throw new Error("strategy identity, version, and module are required");
    const identity = { ...input };
    const hash = contentHash(identity);
    const strategyVersionId = deterministicDomainId(
      "strategy_version",
      `${input.strategyId}:${input.version}`,
    );
    await this.#database.query(
      `INSERT INTO strategy_service_definitions
        (strategy_version_id,strategy_id,version,status,module_key,configuration,registered_at,content_hash)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       ON CONFLICT (strategy_id,version) DO NOTHING`,
      [
        strategyVersionId,
        input.strategyId,
        input.version,
        input.status,
        input.moduleKey,
        JSON.stringify(input.configuration),
        input.registeredAt,
        hash,
      ],
    );
    const existing = await this.#database.query<{ content_hash: string }>(
      `SELECT content_hash FROM strategy_service_definitions WHERE strategy_version_id=$1`,
      [strategyVersionId],
    );
    // This is an immutable public content identity, not secret material.
    // eslint-disable-next-line security/detect-possible-timing-attacks
    if (existing.rows[0]?.content_hash !== hash)
      throw new Error("strategy version is already registered with different content");
    return strategyVersionId;
  }

  public async enqueueSnapshot(input: StrategySnapshotInput): Promise<string> {
    if (input.strategyVersionIds.length === 0)
      throw new Error("at least one strategy version is required");
    if (new Set(input.strategyVersionIds).size !== input.strategyVersionIds.length)
      throw new Error("strategy version list contains duplicates");
    const snapshotBody = {
      featureSnapshotId: input.featureSnapshotId,
      portfolioSnapshotId: input.portfolioSnapshotId,
      observedAt: input.observedAt,
      ...(input.asOfSlot === undefined ? {} : { asOfSlot: input.asOfSlot }),
      mode: input.mode,
      features: input.features,
      provenance: input.provenance,
    };
    const snapshotHash = contentHash(snapshotBody);
    const snapshotId = deterministicDomainId("strategy_snapshot", snapshotHash);
    await this.#database.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO strategy_feature_snapshots
          (snapshot_id,feature_snapshot_id,portfolio_snapshot_id,observed_at,as_of_slot,mode,features,provenance,content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)
         ON CONFLICT (content_hash) DO NOTHING`,
        [
          snapshotId,
          input.featureSnapshotId,
          input.portfolioSnapshotId,
          input.observedAt,
          input.asOfSlot ?? null,
          input.mode,
          JSON.stringify(input.features),
          JSON.stringify(input.provenance),
          snapshotHash,
        ],
      );
      for (const strategyVersionId of input.strategyVersionIds) {
        const jobId = deterministicDomainId("strategy_job", `${snapshotId}:${strategyVersionId}`);
        await transaction.query(
          `INSERT INTO strategy_evaluation_jobs
            (job_id,snapshot_id,strategy_version_id,status,available_at,created_at)
           VALUES ($1,$2,$3,'PENDING',$4,$4)
           ON CONFLICT (snapshot_id,strategy_version_id) DO NOTHING`,
          [jobId, snapshotId, strategyVersionId, input.observedAt],
        );
      }
    });
    return snapshotId;
  }

  public async enqueueLatestCfieControlSnapshot(
    strategyVersionId: string,
    maximumAgeSeconds = 120,
  ): Promise<string | null> {
    const result = await this.#database.query<{
      snapshot_id: string;
      as_of: Date | string;
      price: string;
      quality_score: string | number;
      uncertainty_bps: string | number | null;
      regime: string | null;
      regime_sample_size: number | null;
    }>(
      `SELECT prices.snapshot_id,prices.as_of,prices.price::text,prices.quality_score,
              prices.uncertainty_bps,regimes.state AS regime,
              regimes.sample_size AS regime_sample_size
       FROM reference_price_snapshots prices
       LEFT JOIN LATERAL (
         SELECT state,sample_size FROM market_regime_snapshots
         WHERE as_of<=prices.as_of ORDER BY as_of DESC LIMIT 1
       ) regimes ON true
       WHERE prices.base_asset='SOL' AND prices.status='PUBLISHED'
       ORDER BY prices.as_of DESC LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) return null;
    const observedAt = new Date(row.as_of).toISOString();
    return this.enqueueSnapshot({
      featureSnapshotId: deterministicDomainId("feature", row.snapshot_id),
      portfolioSnapshotId: deterministicDomainId("portfolio", "cfie-shadow-control-v1"),
      observedAt,
      mode: "SHADOW",
      features: {
        referencePriceUsd: row.price,
        qualityScore: Number(row.quality_score),
        uncertaintyBps: row.uncertainty_bps === null ? null : Number(row.uncertainty_bps),
        regime: row.regime ?? "INSUFFICIENT_DATA",
        regimeSampleSize: row.regime_sample_size ?? 0,
      },
      provenance: {
        pointInTimeVerified: true,
        latestSourceAt: observedAt,
        maximumAgeSeconds,
        source: "CFIE_REFERENCE_PRICE_AND_REGIME_V1",
        referenceSnapshotId: row.snapshot_id,
      },
      strategyVersionIds: [strategyVersionId],
    });
  }

  public async enqueueLatestCfieResearchSnapshot(
    strategyVersionIds: readonly string[],
    maximumAgeSeconds = 120,
  ): Promise<readonly string[]> {
    if (strategyVersionIds.length === 0)
      throw new Error("at least one research strategy version is required");
    const result = await this.#database.query<{
      snapshot_id: string;
      as_of: Date | string;
      price: string;
      price_5m_ago: string | null;
      mean_1h: string | null;
      quality_score: string | number;
      uncertainty_bps: string | number | null;
      regime: string | null;
      realized_volatility_pct: string | number | null;
      flow_zscore: string | number | null;
      flow_event_count: string | number | null;
      reaction_features: {
        readonly spreadBpsAfter?: string | null;
        readonly aggressorImbalance?: string | null;
        readonly totalDepthChangePct?: string | null;
        readonly midPriceReturnPct?: string | null;
      } | null;
    }>(
      `SELECT prices.snapshot_id,prices.as_of,prices.price::text,prices.quality_score,
              prices.uncertainty_bps,
              (SELECT prior.price::text FROM reference_price_snapshots prior
               WHERE prior.base_asset='SOL' AND prior.status='PUBLISHED'
                 AND prior.as_of<=prices.as_of-interval '5 minutes'
               ORDER BY prior.as_of DESC LIMIT 1) AS price_5m_ago,
              (SELECT avg(history.price)::text FROM reference_price_snapshots history
               WHERE history.base_asset='SOL' AND history.status='PUBLISHED'
                 AND history.as_of>prices.as_of-interval '1 hour'
                 AND history.as_of<=prices.as_of) AS mean_1h,
              regimes.state AS regime,
              regimes.realized_volatility_pct,
              flows.event_count_zscore AS flow_zscore,
              flows.event_count AS flow_event_count,
              reactions.features AS reaction_features
       FROM reference_price_snapshots prices
       LEFT JOIN LATERAL (
         SELECT state,realized_volatility_pct FROM market_regime_snapshots
         WHERE as_of<=prices.as_of ORDER BY as_of DESC LIMIT 1
       ) regimes ON true
       LEFT JOIN LATERAL (
         SELECT event_count_zscore,event_count FROM protocol_flow_windows
         WHERE window_end<=prices.as_of ORDER BY window_end DESC LIMIT 1
       ) flows ON true
       LEFT JOIN LATERAL (
         SELECT features FROM capital_event_market_reactions
         WHERE window_end<=prices.as_of ORDER BY window_end DESC LIMIT 1
       ) reactions ON true
       WHERE prices.base_asset='SOL' AND prices.status='PUBLISHED'
       ORDER BY prices.as_of DESC LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) return [];
    const bindings = await this.#database.query<{
      strategy_version_id: string;
      hypothesis_id: string | null;
      packet_hash: string | null;
      packet: unknown;
    }>(
      `SELECT definitions.strategy_version_id,
              definitions.configuration->>'evidenceHypothesisId' AS hypothesis_id,
              findings.packet_hash,findings.packet
       FROM strategy_service_definitions definitions
       LEFT JOIN LATERAL (
         SELECT packet_hash,packet FROM research_finding_packets
         WHERE hypothesis_id=definitions.configuration->>'evidenceHypothesisId'
           AND generated_at<= $2
         ORDER BY generated_at DESC,packet_hash DESC LIMIT 1
       ) findings ON true
       WHERE definitions.strategy_version_id=ANY($1::text[])
       ORDER BY definitions.strategy_version_id`,
      [strategyVersionIds, row.as_of],
    );
    if (bindings.rows.length !== strategyVersionIds.length)
      throw new Error("one or more research strategy versions are not registered");
    const numberOrNull = (value: string | number | null): number | null => {
      if (value === null) return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const reaction = row.reaction_features;
    const observedAt = new Date(row.as_of).toISOString();
    return Promise.all(
      bindings.rows.map((binding) => {
        if (binding.hypothesis_id === null)
          throw new Error("research strategy is missing an evidence hypothesis binding");
        const evidence = bindStrategyFindingPacket(binding.packet, binding.hypothesis_id);
        const features = buildCfieResearchFeatures({
          observedAt,
          referencePriceUsd: Number(row.price),
          referencePrice5mAgoUsd: numberOrNull(row.price_5m_ago),
          referenceMean1hUsd: numberOrNull(row.mean_1h),
          referenceConfidence: Number(row.quality_score),
          uncertaintyBps: numberOrNull(row.uncertainty_bps),
          marketRegime: row.regime,
          realizedVolatilityPct: numberOrNull(row.realized_volatility_pct),
          protocolFlowZScore: numberOrNull(row.flow_zscore),
          flowEventCount: numberOrNull(row.flow_event_count),
          spreadBps: numberOrNull(reaction?.spreadBpsAfter ?? null),
          orderBookImbalance: numberOrNull(reaction?.aggressorImbalance ?? null),
          depthChangePct: numberOrNull(reaction?.totalDepthChangePct ?? null),
          reactionReturnPct: numberOrNull(reaction?.midPriceReturnPct ?? null),
          evidenceClassification: evidence.classification,
          evidenceSampleSize: evidence.sampleSize,
          expectedNetBps: evidence.expectedNetBps,
          replayReproducibility: evidence.replayReproducibility,
        });
        return this.enqueueSnapshot({
          featureSnapshotId: deterministicDomainId(
            "feature",
            `cfie-research:${row.snapshot_id}:${binding.strategy_version_id}:${binding.packet_hash ?? "none"}`,
          ),
          portfolioSnapshotId: deterministicDomainId("portfolio", "cfie-research-control-v1"),
          observedAt,
          mode: "BACKTEST",
          features,
          provenance: {
            pointInTimeVerified: true,
            latestSourceAt: observedAt,
            maximumAgeSeconds,
            source: "CFIE_RESEARCH_FEATURE_SNAPSHOT_V2",
            referenceSnapshotId: row.snapshot_id,
            evidenceHypothesisId: binding.hypothesis_id,
            evidencePacketHash: binding.packet_hash,
            evidenceState: evidence.state,
          },
          strategyVersionIds: [binding.strategy_version_id],
        });
      }),
    );
  }

  public async status(): Promise<StrategyServiceStatus> {
    const result = await this.#database.query<{
      pending: number;
      processing: number;
      complete: number;
      failed: number;
      evaluations: number;
      proposals: number;
    }>(`SELECT
      count(*) FILTER (WHERE status='PENDING')::int AS pending,
      count(*) FILTER (WHERE status='PROCESSING')::int AS processing,
      count(*) FILTER (WHERE status='COMPLETE')::int AS complete,
      count(*) FILTER (WHERE status='FAILED')::int AS failed,
      (SELECT count(*)::int FROM strategy_evaluations) AS evaluations,
      (SELECT count(*)::int FROM strategy_trade_proposals) AS proposals
      FROM strategy_evaluation_jobs`);
    return (
      result.rows[0] ?? {
        pending: 0,
        processing: 0,
        complete: 0,
        failed: 0,
        evaluations: 0,
        proposals: 0,
      }
    );
  }

  public async comparison(): Promise<readonly StrategyComparisonRow[]> {
    const result = await this.#database.query<{
      strategy_id: string;
      version: string;
      status: StrategyStatus;
      evaluations: number;
      proposals: number;
      no_trades: number;
      latest_evaluation_at: Date | string | null;
    }>(
      `SELECT definitions.strategy_id,definitions.version,definitions.status,
              count(evaluations.evaluation_id)::int AS evaluations,
              count(evaluations.evaluation_id) FILTER (WHERE evaluations.decision='PROPOSE')::int AS proposals,
              count(evaluations.evaluation_id) FILTER (WHERE evaluations.decision='NO_TRADE')::int AS no_trades,
              max(evaluations.evaluated_at) AS latest_evaluation_at
       FROM strategy_service_definitions definitions
       LEFT JOIN strategy_evaluations evaluations
         ON evaluations.strategy_version_id=definitions.strategy_version_id
       GROUP BY definitions.strategy_version_id,definitions.strategy_id,
                definitions.version,definitions.status
       ORDER BY definitions.strategy_id,definitions.version`,
    );
    return result.rows.map((row) => ({
      strategyId: row.strategy_id,
      version: row.version,
      status: row.status,
      evaluations: row.evaluations,
      proposals: row.proposals,
      noTrades: row.no_trades,
      latestEvaluationAt:
        row.latest_evaluation_at === null ? null : new Date(row.latest_evaluation_at).toISOString(),
    }));
  }

  public async claimJobs(
    ownerId: string,
    limit: number,
    leaseMs: number,
  ): Promise<readonly StrategyJob[]> {
    if (!ownerId) throw new Error("lease owner is required");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("invalid claim limit");
    if (!Number.isInteger(leaseMs) || leaseMs < 1000) throw new Error("invalid lease duration");
    return this.#database.transaction(async (transaction) => {
      const result = await transaction.query<{
        job_id: string;
        snapshot_id: string;
        strategy_version_id: string;
        strategy_status: StrategyStatus;
        module_key: string;
        observed_at: Date | string;
        as_of_slot: string | null;
        mode: Exclude<EvaluationMode, "LIVE">;
        portfolio_snapshot_id: string;
        feature_snapshot_id: string;
        features: ReadonlyFeatureSnapshot;
        provenance: Readonly<Record<string, unknown>>;
      }>(
        `WITH claimable AS (
           SELECT job_id FROM strategy_evaluation_jobs
           WHERE (status='PENDING' AND available_at <= now())
              OR (status='PROCESSING' AND lease_expires_at <= now())
           ORDER BY created_at, job_id FOR UPDATE SKIP LOCKED LIMIT $1
         )
         UPDATE strategy_evaluation_jobs jobs
         SET status='PROCESSING', lease_owner=$2,
             lease_expires_at=now()+($3::text || ' milliseconds')::interval,
             attempts=attempts+1, last_error=NULL
         FROM claimable, strategy_feature_snapshots snapshots, strategy_service_definitions definitions
         WHERE jobs.job_id=claimable.job_id AND snapshots.snapshot_id=jobs.snapshot_id
           AND definitions.strategy_version_id=jobs.strategy_version_id
         RETURNING jobs.job_id, jobs.snapshot_id, jobs.strategy_version_id,
           definitions.status AS strategy_status, definitions.module_key,
           snapshots.observed_at, snapshots.as_of_slot, snapshots.mode,
           snapshots.portfolio_snapshot_id, snapshots.feature_snapshot_id,
           snapshots.features, snapshots.provenance`,
        [limit, ownerId, leaseMs],
      );
      return result.rows.map((row) => ({
        jobId: row.job_id,
        snapshotId: row.snapshot_id,
        evaluationId: deterministicDomainId(
          "evaluation",
          `${row.snapshot_id}:${row.strategy_version_id}`,
        ),
        strategyVersionId: row.strategy_version_id,
        strategyStatus: row.strategy_status,
        moduleKey: row.module_key,
        observedAt: new Date(row.observed_at).toISOString(),
        asOfSlot: row.as_of_slot,
        mode: row.mode,
        portfolioSnapshotId: row.portfolio_snapshot_id,
        featureSnapshotId: row.feature_snapshot_id,
        features: row.features,
        provenance: row.provenance,
      }));
    });
  }

  public async completeJob(
    job: StrategyJob,
    ownerId: string,
    result: StrategyProposalEvaluation,
  ): Promise<void> {
    const resultHash = contentHash(result);
    await this.#database.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO strategy_evaluations
          (evaluation_id,snapshot_id,strategy_version_id,evaluated_at,authority,decision,reasons,input_hash,result,content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10)
         ON CONFLICT (snapshot_id,strategy_version_id) DO NOTHING`,
        [
          result.evaluationId,
          job.snapshotId,
          job.strategyVersionId,
          result.evaluatedAt,
          result.authority,
          result.decision,
          JSON.stringify(result.reasons),
          result.inputHash,
          JSON.stringify(result),
          resultHash,
        ],
      );
      for (const [index, proposal] of result.proposals.entries()) {
        const proposalHash = result.proposalHashes.at(index);
        if (!proposalHash) throw new Error("proposal hash is missing");
        await transaction.query(
          `INSERT INTO strategy_trade_proposals
            (proposal_id,evaluation_id,strategy_version_id,valid_until,proposal,proposal_hash)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (proposal_id) DO NOTHING`,
          [
            proposal.proposalId,
            result.evaluationId,
            job.strategyVersionId,
            proposal.validUntil,
            JSON.stringify(proposal),
            proposalHash,
          ],
        );
      }
      const updated = await transaction.query(
        `UPDATE strategy_evaluation_jobs
         SET status='COMPLETE', lease_owner=NULL, lease_expires_at=NULL
         WHERE job_id=$1 AND status='PROCESSING' AND lease_owner=$2`,
        [job.jobId, ownerId],
      );
      if ((updated.affectedRows ?? 0) !== 1) throw new Error("strategy job lease was lost");
    });
  }

  public async failJob(jobId: string, ownerId: string, error: string): Promise<void> {
    await this.#database.query(
      `UPDATE strategy_evaluation_jobs
       SET status=CASE WHEN attempts >= 5 THEN 'FAILED' ELSE 'PENDING' END,
           available_at=now()+interval '30 seconds', lease_owner=NULL,
           lease_expires_at=NULL, last_error=$3
       WHERE job_id=$1 AND status='PROCESSING' AND lease_owner=$2`,
      [jobId, ownerId, error.slice(0, 2000)],
    );
  }

  public close(): Promise<void> {
    return this.#database.close();
  }
}
