import { contentHash } from "@autonomous-trading-lab/domain";
import type { PerformanceMetrics } from "./metrics.js";

export interface BacktestReport {
  readonly assumptions: {
    readonly costsIncluded: readonly string[];
    readonly latencyModel: string;
    readonly liquidityModel: string;
    readonly sampleSizeDeclaredBeforeRun: number;
  };
  readonly base: PerformanceMetrics;
  readonly stressed: PerformanceMetrics;
  readonly baseline: PerformanceMetrics;
  readonly contentHash: `sha256:${string}`;
}

export function createBacktestReport(input: Omit<BacktestReport, "contentHash">): BacktestReport {
  if (input.assumptions.sampleSizeDeclaredBeforeRun <= 0)
    throw new Error("sample size must be declared before results");
  if (input.assumptions.costsIncluded.length === 0)
    throw new Error("cost assumptions must be disclosed");
  return { ...input, contentHash: contentHash(input) };
}
