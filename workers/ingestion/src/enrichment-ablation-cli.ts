import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { contentHash } from "@autonomous-trading-lab/domain";
import { assertAblationPopulationEquality } from "@autonomous-trading-lab/enrichment";
import { ResearchDatabase } from "./database.js";
import { databaseLocation } from "./database-location.js";
import { deterministicDomainId } from "./ids.js";

async function main(): Promise<void> {
  if (!process.argv.includes("--development-only"))
    throw new Error("enrichment ablation requires --development-only");
  const root = process.env.INIT_CWD ?? process.cwd();
  const database = new ResearchDatabase(
    databaseLocation(root, process.env.CFIE_DATABASE_URL ?? ".atl-data/research-db"),
  );
  const datasetCutoff = new Date().toISOString();
  try {
    await database.migrate(resolve(root, "infra/postgres/migrations"));
    const population = await database.enrichmentAblationPopulation(datasetCutoff, "15m");
    const temporalClusterCount = await database.enrichmentAblationTemporalClusterCount(
      population,
      5,
    );
    const variants = {
      CFIE_BASE: population,
      CFIE_NANSEN: population,
      CFIE_COINGLASS: population,
      CFIE_NANSEN_COINGLASS: population,
    } as const;
    const equality = assertAblationPopulationEquality(variants);
    if (!equality.eligible) throw new Error("enrichment ablation populations differ");
    const policy = {
      version: 2,
      dataset: "DEVELOPMENT_ONLY",
      horizon: "15m",
      missingness: "EXPLICIT_NO_IMPUTATION",
      nansenJoin: "LATEST_VALID_OBSERVATION_RETRIEVED_AT_OR_BEFORE_EVENT",
      coinglassAvailability: "RESTRICTED_MISSING_FEATURE",
      minimumPopulation: 30,
      temporalClusterMinutes: 5,
      maximumObservationsPerTemporalCluster: 20,
      minimumTemporalClusters: 30,
    } as const;
    let persisted = false;
    if (
      population.length >= policy.minimumPopulation &&
      temporalClusterCount >= policy.minimumTemporalClusters
    ) {
      persisted = await database.persistEnrichmentAblationManifest({
        ablationId: deterministicDomainId(
          "enrichment_ablation",
          `${datasetCutoff}:${equality.populationHash}`,
        ),
        createdAt: datasetCutoff,
        datasetCutoff,
        variants,
        basePopulationHash: equality.populationHash,
        outcomeDefinitionHash: contentHash({ horizon: "15m", metric: "return_pct" }),
        policyHash: contentHash(policy),
        holdoutAccessed: false,
      });
    }
    const readiness = {
      authority: "READ_ONLY_RESEARCH",
      dataset: "DEVELOPMENT_ONLY",
      holdoutAccessed: false,
      populationCount: population.length,
      temporalClusterCount,
      minimumTemporalClusters: policy.minimumTemporalClusters,
      equalPopulation: equality.eligible,
      minimumPopulation: policy.minimumPopulation,
      status:
        population.length >= policy.minimumPopulation &&
        temporalClusterCount >= policy.minimumTemporalClusters
          ? "READY"
          : "ACCUMULATING",
      persisted,
    } as const;
    const readinessPath = resolve(root, "artifacts/research/enrichment-readiness-latest.json");
    // Fixed workspace research-artifact directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(resolve(root, "artifacts/research"), { recursive: true });
    // Fixed workspace research-artifact path.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(readinessPath, `${JSON.stringify(readiness, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(readiness)}\n`);
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
