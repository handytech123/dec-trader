import {
  runStrategyProposalEvaluation,
  type StrategyModule,
} from "@autonomous-trading-lab/strategy-sdk";
import type { StrategyJob, StrategyStore } from "./store.js";

export interface StrategyModuleRegistry {
  get(moduleKey: string): StrategyModule | undefined;
}

export interface StrategyCycleResult {
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
}

function assertEligibleSnapshot(job: StrategyJob): void {
  if (job.provenance.pointInTimeVerified !== true)
    throw new Error("snapshot lacks point-in-time verification");
  const latestSourceAt = job.provenance.latestSourceAt;
  const maximumAgeSeconds = job.provenance.maximumAgeSeconds;
  if (typeof latestSourceAt !== "string" || typeof maximumAgeSeconds !== "number")
    throw new Error("snapshot freshness evidence is incomplete");
  const ageMs = Date.parse(job.observedAt) - Date.parse(latestSourceAt);
  if (!Number.isFinite(ageMs) || ageMs < 0)
    throw new Error("snapshot contains future or invalid source data");
  if (!Number.isFinite(maximumAgeSeconds) || maximumAgeSeconds < 0)
    throw new Error("snapshot freshness policy is invalid");
  if (ageMs > maximumAgeSeconds * 1000) throw new Error("snapshot source data is stale");
}

export class StrategyProposalService {
  public constructor(
    private readonly store: StrategyStore,
    private readonly modules: StrategyModuleRegistry,
    private readonly ownerId: string,
  ) {}

  public async runCycle(limit = 10): Promise<StrategyCycleResult> {
    const jobs = await this.store.claimJobs(this.ownerId, limit, 60_000);
    let completed = 0;
    let failed = 0;
    for (const job of jobs) {
      try {
        await this.evaluate(job);
        completed += 1;
      } catch (error: unknown) {
        await this.store.failJob(
          job.jobId,
          this.ownerId,
          error instanceof Error ? error.message : String(error),
        );
        failed += 1;
      }
    }
    return { claimed: jobs.length, completed, failed };
  }

  private async evaluate(job: StrategyJob): Promise<void> {
    assertEligibleSnapshot(job);
    const eligible =
      (job.mode === "BACKTEST" && job.strategyStatus === "RESEARCH_ONLY") ||
      (job.mode === "SHADOW" &&
        (job.strategyStatus === "SHADOW_ELIGIBLE" || job.strategyStatus === "PAPER_ELIGIBLE")) ||
      (job.mode === "PAPER" && job.strategyStatus === "PAPER_ELIGIBLE");
    if (!eligible)
      throw new Error(`strategy is not eligible for evaluation: ${job.strategyStatus}`);
    const module = this.modules.get(job.moduleKey);
    if (!module) throw new Error(`strategy module is unavailable: ${job.moduleKey}`);
    const result = await runStrategyProposalEvaluation(module, {
      strategyVersionId: job.strategyVersionId,
      context: {
        evaluationId: job.evaluationId,
        evaluatedAt: job.observedAt,
        ...(job.asOfSlot === null ? {} : { asOfSlot: job.asOfSlot }),
        mode: job.mode,
        portfolioSnapshotId: job.portfolioSnapshotId,
        featureSnapshotId: job.featureSnapshotId,
      },
      features: job.features,
    });
    await this.store.completeJob(job, this.ownerId, result);
  }
}
