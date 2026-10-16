import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { compareEpisodeInference } from "@autonomous-trading-lab/market-research";
import { ResearchDatabase } from "./database.js";
import { databaseLocation } from "./database-location.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
const percentile = (values: readonly number[], probability: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * probability))] ?? 0;
};
const horizonSeconds = (horizon: string): number => {
  if (horizon === "1m") return 60;
  if (horizon === "5m") return 300;
  if (horizon === "15m") return 900;
  if (horizon === "1h") return 3600;
  if (horizon === "6h") return 21_600;
  if (horizon === "24h") return 86_400;
  return 0;
};

async function main(): Promise<void> {
  if (!process.argv.includes("--benchmark-phase-two"))
    throw new Error("phase two inference benchmark requires --benchmark-phase-two");
  const root = process.env.INIT_CWD ?? process.cwd();
  const database = new ResearchDatabase(
    databaseLocation(
      root,
      process.env.CFIE_DATABASE_URL ?? option("--database") ?? ".atl-data/research-db",
    ),
  );
  const outputPath = resolve(
    root,
    option("--output") ?? "artifacts/benchmarks/phase-two-inference.json",
  );
  try {
    await database.migrate(resolve(root, "infra/postgres/migrations"));
    const observations = await database.pumpSwapFlowResearchObservations(
      option("--cutoff") ?? new Date().toISOString(),
    );
    const byHorizon = new Map<string, typeof observations>();
    for (const observation of observations) {
      const values = byHorizon.get(observation.horizon) ?? [];
      byHorizon.set(observation.horizon, [...values, observation]);
    }
    const results = [];
    for (const [horizon, values] of [...byHorizon.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const input = values.map((item) => ({
        observationId: item.eventId,
        episodeId: item.episodeId ?? item.eventId,
        eventTime: item.eventAt,
        horizonSeconds: horizonSeconds(item.horizon),
        value: item.returnPct,
        ...(item.regime === undefined ? {} : { regime: item.regime }),
      }));
      if (input.length === 0 || input[0]?.horizonSeconds === 0) continue;
      const runtimes: number[] = [];
      let peakHeapBytes = process.memoryUsage().heapUsed;
      let comparison = compareEpisodeInference(input, 20261005);
      for (let iteration = 0; iteration < 5; iteration += 1) {
        const started = performance.now();
        comparison = compareEpisodeInference(input, 20261005 + iteration);
        runtimes.push(performance.now() - started);
        peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
      }
      results.push({
        horizon,
        runtimeMs: {
          p50: percentile(runtimes, 0.5),
          p95: percentile(runtimes, 0.95),
          runs: runtimes,
        },
        peakHeapBytes,
        comparison,
      });
    }
    const report = {
      authority: "READ_ONLY_RESEARCH",
      benchmarkVersion: 1,
      generatedAt: new Date().toISOString(),
      observationCount: observations.length,
      results,
      conclusionDifferences: results.map((result) => ({
        horizon: result.horizon,
        means: Object.fromEntries(
          result.comparison.methods.map((method) => [method.method, method.mean]),
        ),
        materiallyDifferent:
          Math.max(...result.comparison.methods.map((method) => method.mean)) -
            Math.min(...result.comparison.methods.map((method) => method.mean)) >
          0.1,
      })),
    } as const;
    // Explicit CLI-selected artifact directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(dirname(outputPath), { recursive: true });
    // Explicit CLI-selected artifact path.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await database.close();
  }
}
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
