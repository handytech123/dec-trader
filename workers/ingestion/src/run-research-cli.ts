import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { contentHash } from "@autonomous-trading-lab/domain";
import {
  analyzeCategoricalFlows,
  analyzeTransferMagnitude,
  evaluateDevelopmentPromotionGate,
  finalizeResearchFindingPacket,
} from "@autonomous-trading-lab/market-research";
import { ResearchDatabase } from "./database.js";
import { databaseDisplayLocation, databaseLocation } from "./database-location.js";
import { deterministicDomainId } from "./ids.js";
import { buildAndPersistPhaseTwoManifest } from "./phase-two-manifest.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  if (!process.argv.includes("--run-research"))
    throw new Error("research execution requires --run-research");
  const root = process.env.INIT_CWD ?? process.cwd();
  const protocolDatabaseOption = requiredOption("--protocol-database");
  const protocolDatabasePath = databaseLocation(
    root,
    process.env.CFIE_DATABASE_URL ?? protocolDatabaseOption,
  );
  const dataDatabasePath = databaseLocation(
    root,
    process.env.CFIE_DATA_DATABASE_URL ??
      process.env.CFIE_DATABASE_URL ??
      option("--data-database") ??
      protocolDatabaseOption,
  );
  const protocolId = requiredOption("--protocol-id");
  const outputPath = resolve(root, requiredOption("--output"));
  const protocolDatabase = new ResearchDatabase(protocolDatabasePath);
  const dataDatabase =
    dataDatabasePath === protocolDatabasePath
      ? protocolDatabase
      : new ResearchDatabase(dataDatabasePath);
  try {
    await protocolDatabase.migrate(resolve(root, "infra/postgres/migrations"));
    if (dataDatabase !== protocolDatabase)
      await dataDatabase.migrate(resolve(root, "infra/postgres/migrations"));
    const protocol = await protocolDatabase.researchProtocol(protocolId);
    if (!protocol) throw new Error(`research protocol not found: ${protocolId}`);
    if (
      protocol.name === "CFIE Research Phase 1 — Episode-Level Capital Flow Signal Protocol" &&
      new Date() < new Date(protocol.datasetCutoff)
    )
      throw new Error(
        `v3 protocol is sealed until its registered cutoff ${protocol.datasetCutoff}; readiness monitoring must not execute the hypothesis test`,
      );
    const analysisFamily = option("--family") ?? "TRANSFER_MAGNITUDE";
    if (
      analysisFamily !== "TRANSFER_MAGNITUDE" &&
      analysisFamily !== "TRANSFER_MAGNITUDE_BTC_RELATIVE" &&
      analysisFamily !== "CAPITAL_FLOW_EPISODE_BTC_RELATIVE" &&
      analysisFamily !== "DIRECTION" &&
      analysisFamily !== "WALLET_BEHAVIOR" &&
      analysisFamily !== "MARKET_REACTION" &&
      analysisFamily !== "CONDITIONAL_COMBINATION" &&
      analysisFamily !== "PROTOCOL_FLOW"
    )
      throw new Error(`unsupported research family: ${analysisFamily}`);
    const registeredFamily =
      analysisFamily === "TRANSFER_MAGNITUDE_BTC_RELATIVE" ||
      analysisFamily === "CAPITAL_FLOW_EPISODE_BTC_RELATIVE"
        ? "TRANSFER_MAGNITUDE"
        : analysisFamily;
    const family = protocol.families.find((candidate) => candidate.family === registeredFamily);
    if (!family) throw new Error(`protocol does not register ${registeredFamily} research`);
    const openHoldout = process.argv.includes("--open-holdout");
    const promotionEvidenceHash = openHoldout
      ? requiredOption("--promotion-evidence-hash")
      : undefined;
    if (promotionEvidenceHash && !/^sha256:[a-f0-9]{64}$/.test(promotionEvidenceHash))
      throw new Error("--promotion-evidence-hash must be a sha256 content hash");
    if (openHoldout && promotionEvidenceHash) {
      const packet = await protocolDatabase.researchFindingPacket(
        promotionEvidenceHash as `sha256:${string}`,
        protocol.protocolId,
        `${protocol.protocolId}:${analysisFamily}`,
      );
      if (!packet)
        throw new Error("promotion evidence is not a stored finding packet for this family");
      const developmentResult =
        typeof packet === "object" && "developmentResult" in packet
          ? (packet as { readonly developmentResult: unknown }).developmentResult
          : undefined;
      const gate = evaluateDevelopmentPromotionGate(developmentResult);
      if (!gate.eligible)
        throw new Error(`sealed holdout promotion gate failed: ${gate.reasons.join(", ")}`);
    }
    let datasetHash: `sha256:${string}`;
    let analysis;
    if (
      analysisFamily === "TRANSFER_MAGNITUDE" ||
      analysisFamily === "TRANSFER_MAGNITUDE_BTC_RELATIVE" ||
      analysisFamily === "CAPITAL_FLOW_EPISODE_BTC_RELATIVE"
    ) {
      const observations =
        analysisFamily === "CAPITAL_FLOW_EPISODE_BTC_RELATIVE"
          ? await dataDatabase.episodeBenchmarkAdjustedTransferMagnitudeObservations(
              protocol.datasetCutoff,
              deterministicDomainId("instrument", "coinbase:BTC-USD"),
            )
          : analysisFamily === "TRANSFER_MAGNITUDE_BTC_RELATIVE"
            ? await dataDatabase.benchmarkAdjustedTransferMagnitudeObservations(
                protocol.datasetCutoff,
                deterministicDomainId("instrument", "coinbase:BTC-USD"),
              )
            : await dataDatabase.transferMagnitudeObservations(protocol.datasetCutoff);
      datasetHash = contentHash(observations);
      analysis = analyzeTransferMagnitude({
        observations,
        datasetCutoff: protocol.datasetCutoff,
        thresholds: family.thresholds.map((threshold) => {
          const value = threshold.startsWith("z>") ? Number(threshold.slice(2)) : Number.NaN;
          if (!Number.isFinite(value) || value <= 0)
            throw new Error(`unsupported transfer threshold: ${threshold}`);
          return value;
        }),
        minimumSampleSize: protocol.minimumSampleSize,
        holdoutFraction: protocol.holdoutFraction,
        falseDiscoveryRate: protocol.falseDiscoveryRate,
        seed: protocol.seed,
        openHoldout,
      });
    } else {
      const observations =
        analysisFamily === "WALLET_BEHAVIOR"
          ? await dataDatabase.walletBehaviorResearchObservations(protocol.datasetCutoff)
          : analysisFamily === "MARKET_REACTION"
            ? await dataDatabase.marketReactionResearchObservations(protocol.datasetCutoff)
            : analysisFamily === "PROTOCOL_FLOW"
              ? await dataDatabase.pumpSwapFlowResearchObservations(protocol.datasetCutoff)
              : analysisFamily === "CONDITIONAL_COMBINATION"
                ? await dataDatabase.conditionalFlowReactionObservations(protocol.datasetCutoff)
                : await dataDatabase.categoricalFlowObservations(protocol.datasetCutoff);
      datasetHash = contentHash(observations);
      analysis = analyzeCategoricalFlows({
        observations,
        datasetCutoff: protocol.datasetCutoff,
        minimumSampleSize: protocol.minimumSampleSize,
        holdoutFraction: protocol.holdoutFraction,
        falseDiscoveryRate: protocol.falseDiscoveryRate,
        seed: protocol.seed,
        openHoldout,
      });
    }
    const implementationFiles = [
      analysisFamily === "TRANSFER_MAGNITUDE" ||
      analysisFamily === "TRANSFER_MAGNITUDE_BTC_RELATIVE" ||
      analysisFamily === "CAPITAL_FLOW_EPISODE_BTC_RELATIVE"
        ? "packages/market-research/src/phase-one-analysis.ts"
        : "packages/market-research/src/categorical-flow-analysis.ts",
      "packages/market-research/src/robustness.ts",
      "packages/market-research/src/dependence.ts",
      "packages/market-research/src/effect-size.ts",
      "packages/market-research/src/falsification.ts",
      "packages/market-research/src/walk-forward.ts",
      "workers/ingestion/src/database.ts",
      ...(analysisFamily === "PROTOCOL_FLOW" ? ["workers/ingestion/src/protocol-flow.ts"] : []),
    ];
    const implementation = await Promise.all(
      implementationFiles.map(async (file) => {
        const path = resolve(root, file);
        // File names come only from the fixed implementation list above.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        return { file, source: await readFile(path, "utf8") };
      }),
    );
    const codeHash = contentHash(implementation);
    const generatedAt = new Date().toISOString();
    await buildAndPersistPhaseTwoManifest(protocolDatabase, root, generatedAt);
    const qualityManifestId = await protocolDatabase.latestResearchQualityManifestId(generatedAt);
    const runId = deterministicDomainId(
      "research_run",
      `${protocol.protocolId}:${analysisFamily}:1:${codeHash}:${datasetHash}`,
    );
    const inserted = await protocolDatabase.persistResearchAnalysisRun({
      runId,
      protocolId: protocol.protocolId,
      analysisFamily,
      analysisVersion: 1,
      generatedAt,
      codeHash,
      datasetHash,
      ...(qualityManifestId === undefined ? {} : { qualityManifestId }),
      result: analysis,
    });
    const holdoutAuditInserted =
      openHoldout && promotionEvidenceHash
        ? await protocolDatabase.persistHoldoutAccessAudit({
            protocolId: protocol.protocolId,
            runId,
            accessedAt: generatedAt,
            datasetHash,
            codeRevision: codeHash,
            protocolVersion: Number(protocol.version),
            promotionEvidenceHash: promotionEvidenceHash as `sha256:${string}`,
            resultHash: contentHash(analysis),
          })
        : false;
    const researchCells = analysis.cells.filter((cell) => cell.partition === "DEVELOPMENT");
    const robustCells = researchCells.filter((cell) => cell.robustness.status === "COMPLETE");
    const findingPacket = finalizeResearchFindingPacket({
      packetVersion: 1,
      hypothesisId: `${protocol.protocolId}:${analysisFamily}`,
      protocolId: protocol.protocolId,
      runId,
      generatedAt,
      classification:
        analysis.status === "INSUFFICIENT_DATA" ? "INSUFFICIENT_DATA" : "NOT_SUPPORTED",
      codeHash,
      qualityManifestId: qualityManifestId ?? null,
      datasetHash,
      configHash: protocol.contentHash,
      observationCount: analysis.observationCount,
      episodeCount:
        analysisFamily === "CAPITAL_FLOW_EPISODE_BTC_RELATIVE" ? analysis.observationCount : null,
      attributionQuality: "POINT_IN_TIME_ONLY; UNKNOWN_RETAINED",
      effectSizes: robustCells.map((cell) => ({
        horizon: cell.horizon,
        feature: "threshold" in cell ? cell.threshold : cell.cohort,
        rawEffectPct: cell.effectPct,
        distribution: cell.robustness.status === "COMPLETE" ? cell.robustness.fullEffect : null,
      })),
      confidenceIntervals: robustCells.map((cell) => ({
        horizon: cell.horizon,
        feature: "threshold" in cell ? cell.threshold : cell.cohort,
        clusterBootstrap:
          cell.robustness.status === "COMPLETE" ? cell.robustness.clusterBootstrap : null,
      })),
      significance: {
        hypothesisCount: analysis.cells.length,
        falseDiscoveryRate: protocol.falseDiscoveryRate,
        correction: protocol.multipleTestingMethod,
      },
      dependenceDiagnostics: robustCells.map((cell) => ({
        horizon: cell.horizon,
        feature: "threshold" in cell ? cell.threshold : cell.cohort,
        overlap: cell.robustness.status === "COMPLETE" ? cell.robustness.overlap : null,
        nonOverlappingEffect:
          cell.robustness.status === "COMPLETE" ? cell.robustness.nonOverlappingEffect : null,
        overlapDependent:
          cell.robustness.status === "COMPLETE" ? cell.robustness.overlapDependent : null,
        walkForward: cell.robustness.status === "COMPLETE" ? cell.robustness.walkForward : null,
      })),
      baselinesAndFalsification:
        "falsification" in analysis ? analysis.falsification : { status: "FAMILY_SPECIFIC" },
      developmentResult: analysis,
      holdoutResult: { accessed: openHoldout, auditInserted: holdoutAuditInserted },
      frictionSensitivity: robustCells.map((cell) => ({
        horizon: cell.horizon,
        feature: "threshold" in cell ? cell.threshold : cell.cohort,
        materiality: cell.robustness.status === "COMPLETE" ? cell.robustness.materiality : null,
      })),
      contradictoryEvidence: robustCells
        .filter((cell) => cell.robustness.status === "COMPLETE" && cell.robustness.overlapDependent)
        .map((cell) => ({
          horizon: cell.horizon,
          feature: "threshold" in cell ? cell.threshold : cell.cohort,
          reason: "Finding changes materially under deterministic non-overlap sensitivity.",
        })),
      limitations: [
        "No candidate is promoted until dependence, effect-size, materiality, and falsification gates are populated.",
      ],
      humanReviewAction:
        "Review as a research result only; do not translate into a trade instruction.",
    });
    const findingPacketInserted = inserted
      ? await protocolDatabase.persistResearchFindingPacket(findingPacket)
      : false;
    const report = {
      authority: "READ_ONLY_RESEARCH",
      protocolDatabasePath: databaseDisplayLocation(protocolDatabasePath),
      dataDatabasePath: databaseDisplayLocation(dataDatabasePath),
      inserted,
      holdoutAccessed: openHoldout,
      holdoutAuditInserted,
      datasetHash,
      findingPacketInserted,
      findingPacketHash: findingPacket.contentHash,
      protocolId: protocol.protocolId,
      analysisFamily,
      datasetCutoff: protocol.datasetCutoff,
      runId,
      generatedAt,
      codeHash,
      qualityManifestId: qualityManifestId ?? null,
      analysis,
    } as const;
    // The caller explicitly selects the report artifact location.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(dirname(outputPath), { recursive: true });
    // The caller explicitly selects the report artifact location.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (dataDatabase !== protocolDatabase) await dataDatabase.close();
    await protocolDatabase.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
