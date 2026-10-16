import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { contentHash } from "@autonomous-trading-lab/domain";
import {
  PHASE_TWO_HYPOTHESIS_BUDGET,
  evaluateHypothesisBudget,
} from "@autonomous-trading-lab/market-research";
import { ResearchDatabase } from "./database.js";
import { databaseLocation } from "./database-location.js";
import { deterministicDomainId } from "./ids.js";

const definitions = [
  {
    family: "ENTITY_DIRECTION_MAGNITUDE",
    hypothesis:
      "Verified entity direction conditions the relationship between episode magnitude and forward excess return.",
    features: ["point_in_time_direction", "episode_quantity_zscore"],
  },
  {
    family: "WALLET_ABNORMALITY_DIRECTION",
    hypothesis:
      "Wallet-relative abnormality combined with verified direction contains more information than magnitude alone.",
    features: [
      "wallet_quantity_zscore",
      "wallet_frequency_zscore",
      "dormancy_seconds",
      "point_in_time_direction",
    ],
  },
  {
    family: "FLOW_MARKET_REACTION",
    hypothesis:
      "Capital-flow direction conditioned on contemporaneous response failure is associated with subsequent excess return.",
    features: ["point_in_time_direction", "response_failure_label", "aggressor_imbalance"],
  },
  {
    family: "FLOW_REGIME",
    hypothesis:
      "Capital-flow relationships differ across preregistered market regimes without unrestricted slicing.",
    features: ["point_in_time_direction", "market_regime", "btc_relative_return"],
  },
  {
    family: "EPISODE_STRUCTURE",
    hypothesis:
      "Fragmentation, repetition and concentration of an economic episode condition subsequent behavior.",
    features: ["episode_event_count", "counterparty_concentration", "size_escalation"],
  },
  {
    family: "MARKET_RESPONSE_FAILURE",
    hypothesis:
      "Heavy aggression with limited displacement or rapid recovery is more informative than aggression alone.",
    features: ["response_failure_label", "recovery_seconds", "depth_change_pct"],
  },
] as const;

async function main(): Promise<void> {
  if (!process.argv.includes("--register-phase-two-exploration"))
    throw new Error("phase two registration requires --register-phase-two-exploration");
  const root = process.env.INIT_CWD ?? process.cwd();
  const database = new ResearchDatabase(
    databaseLocation(root, process.env.CFIE_DATABASE_URL ?? ".atl-data/research-db"),
  );
  try {
    await database.migrate(resolve(root, "infra/postgres/migrations"));
    const budget = evaluateHypothesisBudget(definitions);
    if (!budget.eligible)
      throw new Error(`hypothesis budget rejected registration: ${budget.violations.join(", ")}`);
    // Fixed implementation source path.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = await readFile(
      resolve(root, "workers/ingestion/src/register-phase-two-hypotheses-cli.ts"),
      "utf8",
    );
    const codeHash = contentHash(source);
    const configHash = contentHash(PHASE_TWO_HYPOTHESIS_BUDGET);
    const registeredAt = new Date().toISOString();
    const results = [];
    for (const definition of definitions) {
      const attemptId = deterministicDomainId(
        "hypothesis",
        `phase2:1:${definition.family}:${contentHash(definition)}`,
      );
      const inserted = await database.persistHypothesisAttempt({
        attemptId,
        family: definition.family,
        familyVersion: 1,
        tier: "EXPLORATORY",
        definition,
        registeredAt,
        status: "REGISTERED",
        codeHash,
        configHash,
      });
      results.push({ attemptId, family: definition.family, inserted });
    }
    process.stdout.write(
      `${JSON.stringify({ authority: "READ_ONLY_RESEARCH", tier: "EXPLORATORY", budget, results }, null, 2)}\n`,
    );
  } finally {
    await database.close();
  }
}
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
