import { contentHash, deterministicDomainId } from "@autonomous-trading-lab/domain";
import { createSqlDatabase, type SqlDatabase } from "@autonomous-trading-lab/ingestion";
import {
  runPaperAgentPipeline,
  type PaperAgentPipelineInput,
  type PaperAgentPipelineResult,
} from "@autonomous-trading-lab/trading-agents";

interface ClaimedCase {
  readonly jobId: string;
  readonly caseId: string;
  readonly input: PaperAgentPipelineInput;
}

export class DurablePaperAgentService {
  readonly #database: SqlDatabase;

  public constructor(
    location: string,
    private readonly ownerId: string,
  ) {
    if (!ownerId) throw new Error("paper agent owner is required");
    this.#database = createSqlDatabase(location);
  }

  public async enqueue(input: PaperAgentPipelineInput, createdAt: string): Promise<string> {
    const hash = contentHash(input);
    const caseId = deterministicDomainId("paper_agent_case", hash);
    const jobId = deterministicDomainId("paper_agent_job", caseId);
    await this.#database.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO paper_agent_cases (case_id,proposal_id,created_at,pipeline_input,content_hash)
         VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (content_hash) DO NOTHING`,
        [caseId, input.candidate.proposal.proposalId, createdAt, JSON.stringify(input), hash],
      );
      await transaction.query(
        `INSERT INTO paper_agent_jobs (job_id,case_id,status,available_at,created_at)
         VALUES ($1,$2,'PENDING',$3,$3) ON CONFLICT (case_id) DO NOTHING`,
        [jobId, caseId, createdAt],
      );
    });
    return caseId;
  }

  public async runCycle(
    limit = 10,
  ): Promise<{ claimed: number; completed: number; failed: number }> {
    const cases = await this.claim(limit);
    let completed = 0;
    let failed = 0;
    for (const candidate of cases) {
      try {
        await this.complete(candidate, runPaperAgentPipeline(candidate.input));
        completed += 1;
      } catch (error: unknown) {
        await this.fail(candidate.jobId, error instanceof Error ? error.message : String(error));
        failed += 1;
      }
    }
    return { claimed: cases.length, completed, failed };
  }

  public async status(): Promise<{
    pending: number;
    processing: number;
    complete: number;
    failed: number;
    runs: number;
  }> {
    const result = await this.#database.query<{
      pending: number;
      processing: number;
      complete: number;
      failed: number;
      runs: number;
    }>(`SELECT
      count(*) FILTER (WHERE status='PENDING')::int AS pending,
      count(*) FILTER (WHERE status='PROCESSING')::int AS processing,
      count(*) FILTER (WHERE status='COMPLETE')::int AS complete,
      count(*) FILTER (WHERE status='FAILED')::int AS failed,
      (SELECT count(*)::int FROM paper_agent_runs) AS runs
      FROM paper_agent_jobs`);
    return result.rows[0] ?? { pending: 0, processing: 0, complete: 0, failed: 0, runs: 0 };
  }

  private async claim(limit: number): Promise<readonly ClaimedCase[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("invalid claim limit");
    return this.#database.transaction(async (transaction) => {
      const result = await transaction.query<{
        job_id: string;
        case_id: string;
        pipeline_input: PaperAgentPipelineInput;
      }>(
        `WITH claimable AS (
           SELECT job_id FROM paper_agent_jobs
           WHERE (status='PENDING' AND available_at<=now())
              OR (status='PROCESSING' AND lease_expires_at<=now())
           ORDER BY created_at,job_id FOR UPDATE SKIP LOCKED LIMIT $1)
         UPDATE paper_agent_jobs jobs SET status='PROCESSING',lease_owner=$2,
           lease_expires_at=now()+interval '60 seconds',attempts=attempts+1,last_error=NULL
         FROM claimable,paper_agent_cases cases
         WHERE jobs.job_id=claimable.job_id AND cases.case_id=jobs.case_id
         RETURNING jobs.job_id,jobs.case_id,cases.pipeline_input`,
        [limit, this.ownerId],
      );
      return result.rows.map((row) => ({
        jobId: row.job_id,
        caseId: row.case_id,
        input: row.pipeline_input,
      }));
    });
  }

  private async complete(candidate: ClaimedCase, result: PaperAgentPipelineResult): Promise<void> {
    const bodyHash = contentHash(result);
    await this.#database.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO paper_agent_runs
          (run_id,case_id,completed_at,authority,outcome,stopped_at,trace,trace_hash,content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) ON CONFLICT (case_id) DO NOTHING`,
        [
          deterministicDomainId("paper_agent_run", candidate.caseId),
          candidate.caseId,
          new Date().toISOString(),
          result.authority,
          result.outcome,
          result.stoppedAt,
          JSON.stringify(result.trace),
          result.traceHash,
          bodyHash,
        ],
      );
      const updated = await transaction.query(
        `UPDATE paper_agent_jobs SET status='COMPLETE',lease_owner=NULL,lease_expires_at=NULL
         WHERE job_id=$1 AND status='PROCESSING' AND lease_owner=$2`,
        [candidate.jobId, this.ownerId],
      );
      if ((updated.affectedRows ?? 0) !== 1) throw new Error("paper agent lease was lost");
    });
  }

  private async fail(jobId: string, error: string): Promise<void> {
    await this.#database.query(
      `UPDATE paper_agent_jobs SET status=CASE WHEN attempts>=5 THEN 'FAILED' ELSE 'PENDING' END,
       available_at=now()+interval '30 seconds',lease_owner=NULL,lease_expires_at=NULL,last_error=$3
       WHERE job_id=$1 AND lease_owner=$2`,
      [jobId, this.ownerId, error.slice(0, 2000)],
    );
  }

  public close(): Promise<void> {
    return this.#database.close();
  }
}
