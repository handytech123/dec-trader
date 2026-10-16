import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { contentHash } from "@autonomous-trading-lab/domain";
import type { ResearchDatabase } from "./database.js";
import { deterministicDomainId } from "./ids.js";

const readJson = async (path: string): Promise<unknown> => {
  try {
    // Callers provide fixed workspace-owned operational paths only.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
};

export async function buildAndPersistPhaseTwoManifest(
  database: ResearchDatabase,
  root: string,
  generatedAt: string,
) {
  const generated = new Date(generatedAt);
  if (Number.isNaN(generated.getTime())) throw new Error("manifest timestamp is invalid");
  const periodEnd = new Date(generated);
  periodEnd.setUTCMinutes(0, 0, 0);
  const periodStart = new Date(periodEnd.getTime() - 86_400_000);
  const [report, attribution, protocolFlow, protocolResearch, health, supervisor, derivation] =
    await Promise.all([
      database.cfieDemoReport(),
      database.entityAttributionQualityReport(generatedAt),
      database.pumpSwapFlowSummary(),
      database.pumpSwapProtocolReadiness(),
      database.operationalHealth(generatedAt, 300, 1000),
      readJson(resolve(root, ".atl-data/cfie-supervisor/status.json")),
      readJson(resolve(root, ".atl-data/cfie-service-postgres/derivation-service.json")),
    ]);
  const implementation = await Promise.all(
    [
      "workers/ingestion/src/phase-two-manifest.ts",
      "workers/ingestion/src/database.ts",
      "packages/market-research/src/phase-two-governance.ts",
    ].map(async (file) => ({
      file,
      // Fixed implementation file allowlist.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      source: await readFile(resolve(root, file), "utf8"),
    })),
  );
  const codeHash = contentHash(implementation);
  const manifest = {
    version: 1,
    authority: "READ_ONLY_RESEARCH; EXECUTION_AUTHORITY_NONE",
    generatedAt,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    volumes: report.counts,
    maturation: report.horizonMaturation,
    collectionService: report.collectionService,
    incidentSummary: report.recentIncidentSummary,
    normalizationQueue: report.normalizationQueue,
    referencePrices: report.recentReferencePrices,
    attribution,
    protocolFlow,
    protocolResearch,
    operationalHealth: health,
    supervisor,
    derivation,
  } as const;
  const manifestId = deterministicDomainId(
    "quality_manifest",
    `phase2:1:${periodEnd.toISOString()}:${contentHash(manifest)}`,
  );
  const inserted = await database.persistResearchQualityManifest({
    manifestId,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    generatedAt,
    manifest,
    codeHash,
  });
  return { manifestId, inserted, codeHash, manifest } as const;
}
