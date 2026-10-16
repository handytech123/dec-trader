import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { contentHash } from "@autonomous-trading-lab/domain";
import { finalizeResearchProtocol } from "@autonomous-trading-lab/market-research";
import { ResearchDatabase } from "./database.js";
import { databaseDisplayLocation, databaseLocation } from "./database-location.js";
import { deterministicDomainId } from "./ids.js";

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
  if (!process.argv.includes("--freeze-protocol"))
    throw new Error("protocol registration requires --freeze-protocol");
  const root = process.env.INIT_CWD ?? process.cwd();
  const databasePath = databaseLocation(
    root,
    process.env.CFIE_DATABASE_URL ?? requiredOption("--database"),
  );
  const implementationFiles = [
    resolve(root, "packages/capital-flow/src/exchange-flow.ts"),
    resolve(root, "packages/market-research/src/reference-price.ts"),
    resolve(root, "packages/market-research/src/phase-one-analysis.ts"),
    resolve(root, "packages/market-research/src/categorical-flow-analysis.ts"),
    resolve(root, "packages/market-research/src/robustness.ts"),
    resolve(root, "packages/market-research/src/dependence.ts"),
    resolve(root, "packages/market-research/src/effect-size.ts"),
    resolve(root, "packages/market-research/src/falsification.ts"),
    resolve(root, "packages/market-research/src/walk-forward.ts"),
    resolve(root, "workers/ingestion/src/database.ts"),
    resolve(root, "workers/ingestion/src/protocol-flow.ts"),
  ];
  const implementation = await Promise.all(
    implementationFiles.map(async (path) => {
      // Paths are fixed repository files, not user-controlled inputs.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      return { path, source: await readFile(path, "utf8") };
    }),
  );
  const frozenAt = new Date().toISOString();
  const profile = option("--profile") ?? "phase1";
  if (profile !== "phase1" && profile !== "phase1v3" && profile !== "pumpswap")
    throw new Error("--profile must be phase1, phase1v3, or pumpswap");
  const name =
    profile === "pumpswap"
      ? "CFIE PumpSwap Protocol-Flow Research"
      : profile === "phase1v3"
        ? "CFIE Research Phase 1 — Episode-Level Capital Flow Signal Protocol"
        : "CFIE Research Phase 1 — Does Capital Flow Contain Signal?";
  const version = option("--version") ?? (profile === "phase1v3" ? "3" : "1");
  if (!/^[1-9][0-9]{0,5}$/.test(version))
    throw new Error("--version must be a positive integer string");
  const seed = option("--seed") ?? "20261003";
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(seed)) throw new Error("--seed is invalid");
  const protocol = finalizeResearchProtocol({
    protocolId: deterministicDomainId("protocol", `${name}:${version}`),
    name,
    version,
    objective:
      profile === "pumpswap"
        ? "Test whether point-in-time PumpSwap fee-recipient flow intensity contains reproducible information about subsequent SOL returns."
        : profile === "phase1v3"
          ? "Test whether independent, point-in-time attributed native SOL capital-flow episodes contain reproducible information about subsequent BTC-relative returns and market response after dependence, attribution, regime, and trading-friction controls."
          : "Test whether point-in-time observable native SOL capital flows contain reproducible information about subsequent returns and market behavior.",
    families:
      profile === "pumpswap"
        ? [
            {
              family: "PROTOCOL_FLOW",
              hypothesis:
                "PumpSwap fee-flow windows with event-count Z-scores at or above 2 or 3, or at or below -2, have different forward SOL return distributions from normal fee-flow windows.",
              features: [
                "pumpswap_fee_event_count_z_v1",
                "pumpswap_native_sol_quantity_v1",
                "pumpswap_wrapped_sol_quantity_v1",
                "pumpswap_distinct_counterparties_v1",
              ],
              thresholds: ["prior_windows>=12", "z>=2", "z>=3", "z<=-2"],
            },
            {
              family: "FALSIFICATION",
              hypothesis:
                "Any PumpSwap protocol-flow effect must survive randomized timestamps, unconditional SOL, BTC controls, regime stratification, outlier removal, unseen holdout data, and costs.",
              features: ["control_effect_difference_v1", "adjusted_p_value_v1"],
              thresholds: ["adjusted_p<=0.05", "minimum_sample>=100"],
            },
          ]
        : profile === "phase1v3"
          ? [
              {
                family: "TRANSFER_MAGNITUDE",
                hypothesis:
                  "Independent capital-flow episodes with point-in-time quantity Z-scores above 2, 3, and 4 have different BTC-relative forward outcomes from registered baselines after costs.",
                features: [
                  "episode_quantity_z_score_v3",
                  "episode_effective_non_overlap_v1",
                  "episode_utc_day_cluster_v1",
                ],
                thresholds: [
                  "z>2",
                  "z>3",
                  "z>4",
                  "independent_utc_days>=21",
                  "effective_non_overlap>=100",
                  "net_effect_bps>friction_bps",
                ],
              },
              {
                family: "DIRECTION",
                hypothesis:
                  "Point-in-time verified exchange, protocol, bridge, and wallet episode directions have different BTC-relative forward outcome distributions; unknown endpoints remain a separate control cohort.",
                features: [
                  "episode_source_entity_class_v3",
                  "episode_destination_entity_class_v3",
                  "episode_direction_v3",
                  "episode_attribution_quality_v1",
                ],
                thresholds: [
                  "attributed_episode_coverage>=0.10",
                  "minimum_direction_episodes>=100",
                  "unknown_retained=true",
                ],
              },
              {
                family: "WALLET_BEHAVIOR",
                hypothesis:
                  "Episode-level transfers unusual relative to an entity's point-in-time size, frequency, dormancy, and counterparty history have different BTC-relative outcomes.",
                features: [
                  "episode_wallet_size_z_v3",
                  "episode_wallet_frequency_z_v3",
                  "episode_wallet_dormancy_seconds_v3",
                  "episode_counterparty_concentration_v1",
                ],
                thresholds: ["minimum_entity_history>=30", "minimum_entity_episodes>=30"],
              },
              {
                family: "MARKET_REACTION",
                hypothesis:
                  "Episode-level order-flow imbalance, spread, liquidity withdrawal, absorption, volatility, and volume condition forward outcomes after venue-quality controls.",
                features: [
                  "episode_aggressor_imbalance_v3",
                  "episode_spread_bps_v3",
                  "episode_depth_change_v3",
                  "episode_absorption_v3",
                  "episode_realized_volatility_v3",
                ],
                thresholds: ["complete_reaction_windows>=100", "venue_incident_free=true"],
              },
              {
                family: "CONDITIONAL_COMBINATION",
                hypothesis:
                  "Only episode-level combinations registered before the sealed holdout may be compared with their individual components and unconditional baselines.",
                features: ["locked_episode_combination_v3"],
                thresholds: ["maximum_registered_combinations=12"],
              },
              {
                family: "FALSIFICATION",
                hypothesis:
                  "A v3 candidate must survive randomized timestamps, BTC-relative and unconditional baselines, regime stratification, outlier removal, deterministic non-overlap, sealed walk-forward holdout, multiple-testing correction, and trading costs.",
                features: [
                  "randomized_timestamp_control_v3",
                  "effective_non_overlap_v3",
                  "cluster_bootstrap_utc_day_v3",
                  "net_effect_after_friction_v3",
                ],
                thresholds: [
                  "adjusted_p<=0.05",
                  "walk_forward_direction_stability>=0.70",
                  "cluster_confidence_interval_excludes_zero=true",
                  "remove_largest_five_survives=true",
                ],
              },
            ]
          : [
              {
                family: "TRANSFER_MAGNITUDE",
                hypothesis:
                  "Native SOL transfers with point-in-time magnitude Z-scores above 1, 2, 3, and 4 have different forward outcome distributions from randomized timestamps.",
                features: ["transfer_quantity_z_score_v1"],
                thresholds: ["z>1", "z>2", "z>3", "z>4"],
              },
              {
                family: "DIRECTION",
                hypothesis:
                  "Evidence-attributed exchange, DEX, bridge, and wallet flow directions have different forward outcome distributions.",
                features: ["from_entity_class_v1", "to_entity_class_v1", "flow_direction_v1"],
                thresholds: [],
              },
              {
                family: "WALLET_BEHAVIOR",
                hypothesis:
                  "Transfers unusual relative to the source entity's point-in-time size, frequency, and dormancy history have different forward outcomes.",
                features: [
                  "wallet_size_z_v1",
                  "wallet_frequency_z_v1",
                  "wallet_dormancy_seconds_v1",
                ],
                thresholds: [],
              },
              {
                family: "MARKET_REACTION",
                hypothesis:
                  "Post-event trade imbalance, spread, depth withdrawal, absorption, volatility, and volume condition forward outcomes.",
                features: [
                  "aggressor_imbalance_v1",
                  "spread_bps_v1",
                  "depth_change_v1",
                  "realized_volatility_v1",
                  "volume_v1",
                ],
                thresholds: [],
              },
              {
                family: "CONDITIONAL_COMBINATION",
                hypothesis:
                  "Only combinations frozen before holdout evaluation may be compared with their individual components and unconditional baselines.",
                features: ["locked_combination_v1"],
                thresholds: [],
              },
              {
                family: "FALSIFICATION",
                hypothesis:
                  "Any candidate effect must survive all registered controls, sensitivity checks, and unseen walk-forward data.",
                features: ["control_effect_difference_v1", "adjusted_p_value_v1"],
                thresholds: ["adjusted_p<=0.05", "minimum_sample>=100"],
              },
            ],
    horizons: ["1m", "5m", "15m", "1h", "6h", "24h"],
    requiredControls: [
      "RANDOMIZED_TIMESTAMPS",
      "UNCONDITIONAL_SOL",
      "BTC_MARKET",
      "REGIME_STRATIFICATION",
      "REMOVE_LARGEST_FIVE",
      "WALK_FORWARD_HOLDOUT",
      "TRADING_COSTS",
    ],
    multipleTestingMethod: "BENJAMINI_HOCHBERG",
    falseDiscoveryRate: 0.05,
    minimumSampleSize: 100,
    holdoutFraction: 0.2,
    seed,
    datasetCutoff: requiredOption("--dataset-cutoff"),
    frozenAt,
    codeHash: contentHash(implementation),
  });
  if (!databasePath.startsWith("postgres") && !databasePath.startsWith("memory://"))
    // The caller explicitly selects the local research database location.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(dirname(databasePath), { recursive: true });
  const database = new ResearchDatabase(databasePath);
  try {
    await database.migrate(resolve(root, "infra/postgres/migrations"));
    const inserted = await database.persistResearchProtocol(protocol);
    process.stdout.write(
      `${JSON.stringify({ databasePath: databaseDisplayLocation(databasePath), inserted, protocol }, null, 2)}\n`,
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
