import { resolve } from "node:path";
import { buildNansenChangeFeatures } from "@autonomous-trading-lab/enrichment";
import { ResearchDatabase } from "./database.js";
import { databaseLocation } from "./database-location.js";
import { deterministicDomainId } from "./ids.js";

async function main(): Promise<void> {
  if (!process.argv.includes("--derive-nansen-features"))
    throw new Error("Nansen feature derivation requires --derive-nansen-features");
  const root = process.env.INIT_CWD ?? process.cwd();
  const database = new ResearchDatabase(
    databaseLocation(root, process.env.CFIE_DATABASE_URL ?? ".atl-data/research-db"),
  );
  try {
    await database.migrate(resolve(root, "infra/postgres/migrations"));
    const observations = await database.nansenMetricSnapshots();
    const features = buildNansenChangeFeatures(observations);
    let inserted = 0;
    for (const feature of features) {
      const featureId = deterministicDomainId(
        "nansen_feature",
        `${feature.subject}:${feature.previousRetrievedAt}:${feature.currentRetrievedAt}:1`,
      );
      if (await database.persistNansenChangeFeature(featureId, feature)) inserted += 1;
    }
    process.stdout.write(
      `${JSON.stringify({
        authority: "READ_ONLY_RESEARCH",
        holdoutAccessed: false,
        sourceObservationCount: observations.length,
        featureCount: features.length,
        inserted,
        status: features.length === 0 ? "ACCUMULATING_SNAPSHOTS" : "FEATURES_READY",
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
