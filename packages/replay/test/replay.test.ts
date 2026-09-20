import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { contentHash, type TradeProposal } from "@autonomous-trading-lab/domain";
import {
  definitionContentHash,
  MarketObservationSchema,
  type Experiment,
  type MarketObservation,
  type StrategyVersion,
} from "@autonomous-trading-lab/data-foundation";
import { replay, type ReplayEvaluator } from "../src/index.js";

const fixturePath = new URL(
  "../../provider-testkit/fixtures/market-observations.json",
  import.meta.url,
);

async function observations(): Promise<readonly MarketObservation[]> {
  // Test-local URL is a constant under the repository fixture directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as { payload: unknown[] };
  return fixture.payload.map((item) => MarketObservationSchema.parse(item));
}

const strategyBody = {
  strategyVersionId: "strategy_01K5J8R4K4F8D8P9Q2Z2T2H3M4",
  strategyDefinitionId: "strategydef_01K5J8R4K4F8D8P9Q2Z2T2H3M4",
  version: "1",
  sourceHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  configHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  featureSchemaHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  eligibility: "RESEARCH",
  publishedAt: "2026-01-01T00:00:00.000Z",
} as const;
const strategyVersion = {
  ...strategyBody,
  contentHash: definitionContentHash(strategyBody),
} satisfies StrategyVersion;

const experimentBody = {
  experimentId: "experiment_01K5J8R4K4F8D8P9Q2Z2T2H3M4",
  hypothesis: "A two-observation increase produces one research proposal",
  strategyVersionId: strategyVersion.strategyVersionId,
  datasetStart: "2026-01-01T12:00:00.000Z",
  datasetEnd: "2026-01-01T12:02:00.000Z",
  mode: "BACKTEST",
  seed: "7",
  status: "REGISTERED",
  registeredAt: "2026-01-01T00:00:00.000Z",
} as const;
const experiment = {
  ...experimentBody,
  contentHash: definitionContentHash(experimentBody),
} satisfies Experiment;

const proposal: TradeProposal = {
  proposalId: "proposal_01K5J8R4K4F8D8P9Q2Z2T2H3M4",
  strategyVersionId: strategyVersion.strategyVersionId,
  experimentId: experiment.experimentId,
  side: "BUY",
  inputMint: "11111111111111111111111111111111",
  outputMint: "So11111111111111111111111111111111111111112",
  requestedInputAtomic: "1000000",
  thesisCode: "SYNTHETIC_REPLAY",
  signalValues: { observedCount: 2 },
  validUntil: "2026-01-01T12:02:00.000Z",
};

const evaluator: ReplayEvaluator = (context) => {
  expect(context.observations).toHaveLength(2);
  return [proposal];
};

describe("deterministic replay", () => {
  it("produces identical proposals and hashes from identical recorded inputs", async () => {
    const recorded = await observations();
    const first = replay({ experiment, strategyVersion, observations: recorded }, evaluator);
    const second = replay(
      { experiment, strategyVersion, observations: [...recorded].reverse() },
      evaluator,
    );
    expect(second).toEqual(first);
    expect(first.observationCount).toBe(2);
    expect(first.proposalHash).toBe(contentHash([proposal]));
  });

  it("changes replay identity when a bounded input changes", async () => {
    const recorded = await observations();
    const baseline = replay({ experiment, strategyVersion, observations: recorded }, evaluator);
    const changed = recorded.map((item, index) =>
      index === 0 ? { ...item, price: "1.000001" } : item,
    );
    const result = replay({ experiment, strategyVersion, observations: changed }, evaluator);
    expect(result.inputHash).not.toBe(baseline.inputHash);
    expect(result.replayHash).not.toBe(baseline.replayHash);
  });

  it("rejects an experiment bound to another strategy version", async () => {
    const recorded = await observations();
    expect(() =>
      replay(
        {
          experiment: { ...experiment, strategyVersionId: "strategy_01K5J8R4K4F8D8P9Q2Z2T2H3M5" },
          strategyVersion,
          observations: recorded,
        },
        evaluator,
      ),
    ).toThrow("do not match");
  });
});
