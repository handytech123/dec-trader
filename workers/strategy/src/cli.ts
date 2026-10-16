import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ResearchDatabase } from "@autonomous-trading-lab/ingestion";
import { deterministicDomainId } from "@autonomous-trading-lab/domain";
import {
  createCrossVenueDislocationStrategy,
  createFlowAwareMeanReversionStrategy,
  createFlowConfirmedMomentumStrategy,
  createLiquidityConfirmedBreakoutStrategy,
  createPostFlowContinuationStrategy,
  createPostFlowReversalStrategy,
  createResponseFailureStrategy,
  type StrategyModule,
} from "@autonomous-trading-lab/strategy-sdk";
import { StrategyProposalService } from "./service.js";
import { PostgresStrategyStore } from "./store.js";

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const noTradeBaseline: StrategyModule = { evaluate: () => [] };

async function main(): Promise<void> {
  if (!process.argv.includes("--enable-paper-proposal-service"))
    throw new Error("strategy service requires --enable-paper-proposal-service");
  const root = process.env.INIT_CWD ?? process.cwd();
  const location =
    process.env.CFIE_DATABASE_URL ?? resolve(root, option("--database") ?? ".atl-data/research-db");
  const migrationDatabase = new ResearchDatabase(location);
  await migrationDatabase.migrate(resolve(root, "infra/postgres/migrations"));
  await migrationDatabase.close();

  const store = new PostgresStrategyStore(location);
  try {
    const controlStrategyVersionId = await store.registerStrategy({
      strategyId: "NO_TRADE_BASELINE",
      version: "1",
      status: "SHADOW_ELIGIBLE",
      moduleKey: "NO_TRADE_BASELINE_V1",
      configuration: { purpose: "pipeline-control" },
      registeredAt: "2026-10-12T00:00:00.000Z",
    });
    const responseFailureVersionId = await store.registerStrategy({
      strategyId: "CFIE_RESPONSE_FAILURE",
      version: "2",
      status: "RESEARCH_ONLY",
      moduleKey: "CFIE_RESPONSE_FAILURE_V1",
      configuration: {
        thesis: "HEAVY_SELLING_LIMITED_DOWNSIDE",
        evidenceHypothesisId: "CFIE_STRATEGY:RESPONSE_FAILURE:V1",
        activationGate: "SUPPORTED_EDGE_AND_REPLAY_REPRODUCIBILITY_GTE_0_95",
      },
      registeredAt: "2026-10-14T00:00:00.000Z",
    });
    const flowMomentumVersionId = await store.registerStrategy({
      strategyId: "CFIE_FLOW_CONFIRMED_MOMENTUM",
      version: "2",
      status: "RESEARCH_ONLY",
      moduleKey: "CFIE_FLOW_CONFIRMED_MOMENTUM_V1",
      configuration: {
        thesis: "RISING_PRICE_VOLUME_LIQUIDITY_AND_PROTOCOL_FLOW_AGREE",
        evidenceHypothesisId: "CFIE_STRATEGY:FLOW_CONFIRMED_MOMENTUM:V1",
        activationGate: "SUPPORTED_EDGE_SAMPLE_GTE_100_AND_REPLAY_REPRODUCIBILITY_GTE_0_95",
      },
      registeredAt: "2026-10-14T00:00:00.000Z",
    });
    const continuationVersionId = await store.registerStrategy({
      strategyId: "CFIE_POST_FLOW_CONTINUATION",
      version: "2",
      status: "RESEARCH_ONLY",
      moduleKey: "CFIE_POST_FLOW_CONTINUATION_V1",
      configuration: {
        thesis: "LARGE_INFLOW_WITH_PRICE_VOLUME_AND_ORDER_BOOK_CONFIRMATION",
        evidenceHypothesisId: "CFIE_STRATEGY:POST_FLOW_CONTINUATION:V1",
        activationGate: "SUPPORTED_EDGE_SAMPLE_GTE_100_AND_REPLAY_REPRODUCIBILITY_GTE_0_95",
      },
      registeredAt: "2026-10-14T00:00:00.000Z",
    });
    const reversalVersionId = await store.registerStrategy({
      strategyId: "CFIE_POST_FLOW_REVERSAL",
      version: "2",
      status: "RESEARCH_ONLY",
      moduleKey: "CFIE_POST_FLOW_REVERSAL_V1",
      configuration: {
        thesis: "OUTFLOW_SHOCK_WITH_LIQUID_BUY_SUPPORTED_RECOVERY",
        evidenceHypothesisId: "CFIE_STRATEGY:POST_FLOW_REVERSAL:V1",
        activationGate: "SUPPORTED_EDGE_SAMPLE_GTE_100_AND_REPLAY_REPRODUCIBILITY_GTE_0_95",
      },
      registeredAt: "2026-10-14T00:00:00.000Z",
    });
    const breakoutVersionId = await store.registerStrategy({
      strategyId: "CFIE_LIQUIDITY_CONFIRMED_BREAKOUT",
      version: "2",
      status: "RESEARCH_ONLY",
      moduleKey: "CFIE_LIQUIDITY_CONFIRMED_BREAKOUT_V1",
      configuration: {
        thesis: "MULTI_VENUE_BREAKOUT_WITH_RETAINED_DEPTH_AND_VOLUME_CONFIRMATION",
        evidenceHypothesisId: "CFIE_STRATEGY:LIQUIDITY_CONFIRMED_BREAKOUT:V1",
        activationGate: "SUPPORTED_EDGE_SAMPLE_GTE_100_AND_REPLAY_REPRODUCIBILITY_GTE_0_95",
      },
      registeredAt: "2026-10-14T00:00:00.000Z",
    });
    const dislocationVersionId = await store.registerStrategy({
      strategyId: "CFIE_CROSS_VENUE_DISLOCATION",
      version: "2",
      status: "RESEARCH_ONLY",
      moduleKey: "CFIE_CROSS_VENUE_DISLOCATION_V1",
      configuration: {
        thesis: "FRESH_EXECUTABLE_DEX_DISCOUNT_TO_TWO_VENUE_REFERENCE_AFTER_COSTS",
        evidenceHypothesisId: "CFIE_STRATEGY:CROSS_VENUE_DISLOCATION:V1",
        activationGate: "SUPPORTED_EDGE_SAMPLE_GTE_100_AND_REPLAY_REPRODUCIBILITY_GTE_0_95",
      },
      registeredAt: "2026-10-14T00:00:00.000Z",
    });
    const meanReversionVersionId = await store.registerStrategy({
      strategyId: "CFIE_FLOW_AWARE_MEAN_REVERSION",
      version: "2",
      status: "RESEARCH_ONLY",
      moduleKey: "CFIE_FLOW_AWARE_MEAN_REVERSION_V1",
      configuration: {
        thesis: "DEPRESSED_PRICE_RECOVERY_WITH_NON_NEGATIVE_PROTOCOL_FLOW",
        evidenceHypothesisId: "CFIE_STRATEGY:FLOW_AWARE_MEAN_REVERSION:V1",
        activationGate: "SUPPORTED_EDGE_SAMPLE_GTE_100_AND_REPLAY_REPRODUCIBILITY_GTE_0_95",
      },
      registeredAt: "2026-10-14T00:00:00.000Z",
    });
    const commonResearchConfig = {
      inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outputMint: "So11111111111111111111111111111111111111112",
      requestedInputAtomic: "1000000",
      minimumExpectedNetBps: 10,
      minimumEvidenceSampleSize: 100,
      minimumReplayReproducibility: 0.95,
      proposalLifetimeSeconds: 60,
    } as const;
    const responseFailure = createResponseFailureStrategy({
      strategyVersionId: responseFailureVersionId,
      experimentId: deterministicDomainId("experiment", "cfie-response-failure-v1"),
      inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outputMint: "So11111111111111111111111111111111111111112",
      requestedInputAtomic: "1000000",
      minimumExpectedNetBps: 10,
      minimumEvidenceSampleSize: 100,
      proposalLifetimeSeconds: 60,
    });
    const flowMomentum = createFlowConfirmedMomentumStrategy({
      ...commonResearchConfig,
      strategyVersionId: flowMomentumVersionId,
      experimentId: deterministicDomainId("experiment", "cfie-flow-confirmed-momentum-v1"),
      minimumReturn5mBps: 20,
      minimumVolumeAcceleration: 1.2,
      minimumLiquidityScore: 0.7,
      maximumSpreadBps: 25,
      minimumProtocolFlowZScore: 2,
    });
    const continuation = createPostFlowContinuationStrategy({
      ...commonResearchConfig,
      strategyVersionId: continuationVersionId,
      experimentId: deterministicDomainId("experiment", "cfie-post-flow-continuation-v1"),
      minimumFlowMagnitudeZScore: 2,
      minimumConfirmationReturnBps: 10,
      minimumVolumeAcceleration: 1.2,
      minimumOrderBookImbalance: 0.1,
      minimumLiquidityScore: 0.7,
      maximumSpreadBps: 25,
    });
    const reversal = createPostFlowReversalStrategy({
      ...commonResearchConfig,
      strategyVersionId: reversalVersionId,
      experimentId: deterministicDomainId("experiment", "cfie-post-flow-reversal-v1"),
      minimumFlowMagnitudeZScore: 2,
      maximumShockReturnBps: -40,
      minimumRecoveryReturnBps: 10,
      minimumOrderBookImbalance: 0.1,
      minimumLiquidityScore: 0.7,
      maximumSpreadBps: 25,
    });
    const breakout = createLiquidityConfirmedBreakoutStrategy({
      ...commonResearchConfig,
      strategyVersionId: breakoutVersionId,
      experimentId: deterministicDomainId("experiment", "cfie-liquidity-breakout-v1"),
      minimumBreakoutBps: 30,
      minimumVolumeAcceleration: 1.3,
      minimumDepthRetentionScore: 0.75,
      minimumVenueConfirmations: 2,
      minimumLiquidityScore: 0.7,
      maximumSpreadBps: 25,
    });
    const dislocation = createCrossVenueDislocationStrategy({
      ...commonResearchConfig,
      strategyVersionId: dislocationVersionId,
      experimentId: deterministicDomainId("experiment", "cfie-cross-venue-dislocation-v1"),
      minimumDexDiscountBps: 40,
      minimumExecutableEdgeBps: 15,
      minimumReferenceConfidence: 0.9,
      maximumQuoteAgeMs: 2_000,
      maximumEstimatedCostBps: 30,
    });
    const meanReversion = createFlowAwareMeanReversionStrategy({
      ...commonResearchConfig,
      strategyVersionId: meanReversionVersionId,
      experimentId: deterministicDomainId("experiment", "cfie-flow-aware-mean-reversion-v1"),
      minimumNegativeDeviationBps: 50,
      minimumRecoveryBps: 10,
      minimumProtocolFlowZScore: 0,
      minimumLiquidityScore: 0.75,
      maximumSpreadBps: 20,
    });
    const modules = new Map<string, StrategyModule>([
      ["NO_TRADE_BASELINE_V1", noTradeBaseline],
      ["CFIE_RESPONSE_FAILURE_V1", responseFailure],
      ["CFIE_FLOW_CONFIRMED_MOMENTUM_V1", flowMomentum],
      ["CFIE_POST_FLOW_CONTINUATION_V1", continuation],
      ["CFIE_POST_FLOW_REVERSAL_V1", reversal],
      ["CFIE_LIQUIDITY_CONFIRMED_BREAKOUT_V1", breakout],
      ["CFIE_CROSS_VENUE_DISLOCATION_V1", dislocation],
      ["CFIE_FLOW_AWARE_MEAN_REVERSION_V1", meanReversion],
    ]);
    const service = new StrategyProposalService(store, modules, randomUUID());
    const researchStrategyVersionIds = [
      responseFailureVersionId,
      flowMomentumVersionId,
      continuationVersionId,
      reversalVersionId,
      breakoutVersionId,
      dislocationVersionId,
      meanReversionVersionId,
    ];
    const maximumCycles = Number(option("--maximum-cycles") ?? "1");
    const intervalSeconds = Number(option("--interval-seconds") ?? "10");
    if (!Number.isInteger(maximumCycles) || maximumCycles < 1)
      throw new Error("maximum cycles must be a positive integer");
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 3600)
      throw new Error("interval seconds must be between 1 and 3600");
    for (let cycle = 0; cycle < maximumCycles; cycle += 1) {
      const bridgedSnapshotId = process.argv.includes("--bridge-cfie-control")
        ? await store.enqueueLatestCfieControlSnapshot(controlStrategyVersionId)
        : null;
      const bridgedResearchSnapshotIds = process.argv.includes("--bridge-cfie-research")
        ? await store.enqueueLatestCfieResearchSnapshot(researchStrategyVersionIds)
        : [];
      const cycleResult = await service.runCycle(10);
      process.stdout.write(
        `${JSON.stringify({
          authority: "PAPER_PROPOSAL_ONLY",
          bridgedSnapshotId,
          bridgedResearchSnapshotIds,
          cycleResult,
          status: await store.status(),
          comparison: await store.comparison(),
        })}\n`,
      );
      if (cycle + 1 < maximumCycles)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalSeconds * 1000));
    }
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
