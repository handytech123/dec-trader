import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { contentHash } from "@autonomous-trading-lab/domain";
import { evaluateEnrichmentAblation } from "@autonomous-trading-lab/enrichment";
import { ResearchDatabase } from "./database.js";
import { databaseLocation } from "./database-location.js";
import { deterministicDomainId } from "./ids.js";

const EVALUATION_VERSION = 2;
const CODE_HASH = contentHash({
  component: "nansen-incremental-value",
  version: EVALUATION_VERSION,
});

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const standardize = (values: readonly number[]): number[] => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.length < 2
      ? 0
      : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const deviation = Math.sqrt(variance);
  return values.map((value) => (deviation === 0 ? 0 : (value - mean) / deviation));
};

async function main(): Promise<void> {
  if (!process.argv.includes("--development-only"))
    throw new Error("enrichment evaluation requires --development-only");
  const root = process.env.INIT_CWD ?? process.cwd();
  const database = new ResearchDatabase(
    databaseLocation(root, process.env.CFIE_DATABASE_URL ?? ".atl-data/research-db"),
  );
  try {
    await database.migrate(resolve(root, "infra/postgres/migrations"));
    const population = await database.latestEnrichmentAblationEvaluationPopulation();
    if ((!population || population.rows.length < 30) && process.argv.includes("--if-ready")) {
      process.stdout.write(
        `${JSON.stringify({ status: "ACCUMULATING", observationCount: population?.rows.length ?? 0, minimumPopulation: 30, providerCallsMade: 0 })}\n`,
      );
      return;
    }
    if (!population || population.rows.length < 30)
      throw new Error("a matured enrichment ablation population of at least 30 is required");
    const baseScores = standardize(population.rows.map((row) => Math.log1p(row.quantity)));
    const rawNansen = population.rows.map((row) => row.nansenScore);
    const availableNansen = rawNansen.filter((value): value is number => value !== null);
    const standardizedNansen = standardize(availableNansen);
    let nansenIndex = 0;
    const nansenScores = rawNansen.map((value) => {
      if (value === null) return null;
      const standardized = standardizedNansen.at(nansenIndex) ?? 0;
      nansenIndex += 1;
      return standardized;
    });
    const evaluation = evaluateEnrichmentAblation(
      population.rows.map((row, index) => ({
        eventId: row.eventId,
        eventTime: row.eventTime,
        returnPct: row.returnPct,
        normalSolReturnPct: row.normalSolReturnPct,
        btcReturnPct: row.btcReturnPct,
        baseScore: baseScores.at(index) ?? 0,
        nansenScore: nansenScores.at(index) ?? null,
        coinglassScore: null,
        regime: row.regime,
        magnitudeBucket: row.magnitudeBucket,
      })),
      { bootstrapIterations: 1_000, permutationIterations: 1_000, randomSeed: 20_261_006 },
    );
    const generatedAt = new Date().toISOString();
    const result = {
      authority: "READ_ONLY_RESEARCH",
      dataset: "DEVELOPMENT_ONLY",
      holdoutAccessed: false,
      providerCallsMade: 0,
      ablationId: population.ablationId,
      datasetCutoff: population.datasetCutoff,
      generatedAt,
      observationCount: population.rows.length,
      nansenAvailableCount: availableNansen.length,
      nansenMissingCount: rawNansen.length - availableNansen.length,
      coinglassStatus: "RESTRICTED_NOT_EVALUATED",
      evaluation,
    } as const;
    const evaluationId = deterministicDomainId(
      "enrichment_evaluation",
      `${population.ablationId}:${String(EVALUATION_VERSION)}:${CODE_HASH}`,
    );
    const persisted = await database.persistEnrichmentAblationEvaluation({
      evaluationId,
      ablationId: population.ablationId,
      generatedAt,
      datasetCutoff: population.datasetCutoff,
      evaluationVersion: EVALUATION_VERSION,
      observationCount: population.rows.length,
      eventTimeClusterCount: evaluation.incrementalValue.uniqueEventTimeClusters,
      result,
      codeHash: CODE_HASH,
      holdoutAccessed: false,
    });
    const outputPath = resolve(
      root,
      option("--output") ?? "artifacts/research/nansen-incremental-value-latest.json",
    );
    // The path is resolved beneath the caller-selected workspace and contains research output only.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(dirname(outputPath), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    const reportPath = resolve(
      root,
      option("--report") ?? "artifacts/research/nansen-incremental-value-latest.md",
    );
    const incremental = evaluation.incrementalValue;
    const report = `# CFIE Nansen Incremental-Value Report

Generated: ${generatedAt}

## Decision

**${incremental.verdict}**

This is exploratory development-only research. It is not a trading recommendation, the holdout
remains sealed, and the evaluation made no provider calls.

## Evidence

- Equal-population observations: ${String(population.rows.length)}
- Independent event-time clusters: ${String(incremental.uniqueEventTimeClusters)}
- Distinct Nansen states: ${String(incremental.uniqueNansenStates)}
- Nansen observations available: ${String(availableNansen.length)}
- BTC controls available: ${String(evaluation.controls.btcAvailableCount)}
- Incremental score/return correlation: ${incremental.observedCorrelationDelta.toFixed(6)}
- Cluster-bootstrap 95% interval: ${String(incremental.clusterBootstrap95Pct.lower)} to ${String(incremental.clusterBootstrap95Pct.upper)}
- Shuffled-feature permutation p-value: ${incremental.permutationPValue.toFixed(6)}
- Multiple-testing-adjusted p-value: ${incremental.benjaminiHochbergAdjustedPValue.toFixed(6)}
- Extreme observations removed: ${String(incremental.extremeObservationRemoval.removedCount)}

## Interpretation

${incremental.verdict === "INSUFFICIENT_TEMPORAL_VARIATION" ? "The cohort does not yet contain enough independent times or changing Nansen states to test incremental value reliably. Continue collection without loosening the point-in-time rules." : incremental.verdict === "CANDIDATE_SIGNAL_NOT_VALIDATED" ? "The development cohort contains a candidate effect. It must survive the sealed holdout, costs, and replication before any economic claim." : "Nansen did not add measurable incremental value under the registered development-cohort test."}

CoinGlass remains restricted and was not imputed or evaluated.
`;
    // The path is resolved beneath the caller-selected workspace and contains research output only.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(dirname(reportPath), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(reportPath, report, "utf8");
    process.stdout.write(
      `${JSON.stringify({
        evaluationId,
        persisted,
        outputPath,
        reportPath,
        observationCount: population.rows.length,
        verdict: evaluation.incrementalValue.verdict,
        correlationDelta: evaluation.incrementalValue.observedCorrelationDelta,
        permutationPValue: evaluation.incrementalValue.permutationPValue,
        clusterBootstrap95Pct: evaluation.incrementalValue.clusterBootstrap95Pct,
        holdoutAccessed: false,
        providerCallsMade: 0,
      })}\n`,
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
