import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { contentHash } from "@autonomous-trading-lab/domain";
import {
  computeFeatureValues,
  definitionContentHash,
  ImmutableRegistry,
  normalizeObservation,
  ObservationSet,
  pointInTimeObservations,
  type Experiment,
  type FeatureDefinition,
  type MarketObservation,
  type RawObservation,
} from "../src/index.js";

const rawFixturePath = new URL(
  "../../provider-testkit/fixtures/raw-market-observation.json",
  import.meta.url,
);

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const raw = (sourceId: string, sourceTime: string): RawObservation => ({
  observationId: "observation_01K5J8R4K4F8D8P9Q2Z2T2H3M4",
  ingestionId: "ingestion_01K5J8R4K4F8D8P9Q2Z2T2H3M4",
  source: "synthetic",
  sourceId,
  observedAt: "2026-01-01T12:00:01.000Z",
  sourceTime,
  schemaVersion: "1",
  payload: { price: "1.0" },
  payloadHash: contentHash({ price: "1.0" }),
});

describe("data foundation", () => {
  it("normalizes a hash-bound provider fixture behind an adapter", async () => {
    // Test-local URL is a constant under the repository fixture directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const fixture = JSON.parse(await readFile(rawFixturePath, "utf8")) as {
      payload: RawObservation;
    };
    const normalized = normalizeObservation(fixture.payload, {
      source: "synthetic-market",
      normalize: (observation) => {
        const payload = observation.payload as {
          price: string;
          volume: string;
          liquidity: string;
        };
        return {
          observationId: observation.observationId,
          rawObservationHash: contentHash(observation),
          assetId: "asset_01K5J8R4K4F8D8P9Q2Z2T2H3M4",
          price: payload.price,
          volume: payload.volume,
          liquidity: payload.liquidity,
          observedAt: observation.observedAt,
          sourceTime: observation.sourceTime,
          ...(observation.slot === undefined ? {} : { slot: observation.slot }),
          source: observation.source,
          schemaVersion: "1",
        };
      },
    });
    expect(normalized.price).toBe("1.000000");
  });

  it("rejects a provider payload changed after hashing", () => {
    const observation = {
      ...raw("tampered", "2026-01-01T12:00:00.000Z"),
      payloadHash: hash("a"),
    };
    expect(() =>
      normalizeObservation(observation, {
        source: observation.source,
        normalize: () => ({}) as MarketObservation,
      }),
    ).toThrow("payload hash mismatch");
  });

  it("rejects a mismatched normalizer source", async () => {
    // Test-local URL is a constant under the repository fixture directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const fixture = JSON.parse(await readFile(rawFixturePath, "utf8")) as {
      payload: RawObservation;
    };
    expect(() =>
      normalizeObservation(fixture.payload, {
        source: "another-source",
        normalize: () => ({}) as MarketObservation,
      }),
    ).toThrow("source does not match");
  });

  it("rejects normalized output not bound to its raw input", async () => {
    // Test-local URL is a constant under the repository fixture directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const fixture = JSON.parse(await readFile(rawFixturePath, "utf8")) as {
      payload: RawObservation;
    };
    expect(() =>
      normalizeObservation(fixture.payload, {
        source: fixture.payload.source,
        normalize: (observation) => ({
          observationId: observation.observationId,
          rawObservationHash: hash("e"),
          assetId: "asset_01K5J8R4K4F8D8P9Q2Z2T2H3M4",
          price: "1.0",
          volume: "1.0",
          liquidity: "1.0",
          observedAt: observation.observedAt,
          sourceTime: observation.sourceTime,
          source: observation.source,
          schemaVersion: "1",
        }),
      }),
    ).toThrow("not bound");
  });

  it("deduplicates stable provider identity and returns deterministic order", () => {
    const set = new ObservationSet();
    expect(set.accept(raw("later", "2026-01-01T12:01:00.000Z")).accepted).toBe(true);
    expect(set.accept(raw("later", "2026-01-01T12:01:00.000Z")).accepted).toBe(false);
    expect(set.accept(raw("earlier", "2026-01-01T12:00:00.000Z")).accepted).toBe(true);
    expect(set.ordered().map((item) => item.sourceId)).toEqual(["earlier", "later"]);
  });

  it("rejects tampered payloads at ingestion", () => {
    const set = new ObservationSet();
    expect(() =>
      set.accept({
        ...raw("bad", "2026-01-01T12:00:00.000Z"),
        payloadHash: hash("f"),
      }),
    ).toThrow("payload hash mismatch");
  });

  it("never exposes future time or slot observations", () => {
    const observations = [
      { sourceTime: "2026-01-01T12:00:00.000Z", slot: "100" },
      { sourceTime: "2026-01-01T12:01:00.000Z", slot: "102" },
      { sourceTime: "2026-01-01T12:02:00.000Z", slot: "101" },
    ] as MarketObservation[];
    const bounded = pointInTimeObservations(observations, "2026-01-01T12:01:30.000Z", "101");
    expect(bounded).toHaveLength(1);
    expect(bounded[0]?.slot).toBe("100");
  });

  it("computes features in definition-name order", () => {
    const base = {
      featureDefinitionId: "feature_01K5J8R4K4F8D8P9Q2Z2T2H3M4",
      version: "1",
      units: "ratio",
      window: "5m",
      sources: ["synthetic"],
      nullBehavior: "REJECT",
      freshnessLimitSeconds: 15,
      codeHash: hash("a"),
      configHash: hash("b"),
      contentHash: hash("c"),
      publishedAt: "2026-01-01T00:00:00.000Z",
    } as const;
    const definitions = [
      { ...base, name: "zeta" },
      { ...base, name: "alpha" },
    ] as FeatureDefinition[];
    const result = computeFeatureValues(definitions, [], { alpha: () => "1", zeta: () => "2" });
    expect(Object.keys(result.values)).toEqual(["alpha", "zeta"]);
    expect(result.contentHash).toBe(contentHash({ alpha: "1", zeta: "2" }));
  });

  it("rejects mutation and false content identity", () => {
    const body = {
      experimentId: "experiment_01K5J8R4K4F8D8P9Q2Z2T2H3M4",
      hypothesis: "A falsifiable hypothesis",
      strategyVersionId: "strategy_01K5J8R4K4F8D8P9Q2Z2T2H3M4",
      datasetStart: "2026-01-01T00:00:00.000Z",
      datasetEnd: "2026-01-02T00:00:00.000Z",
      mode: "BACKTEST",
      seed: "42",
      status: "REGISTERED",
      registeredAt: "2026-01-01T00:00:00.000Z",
    } as const;
    const record = { ...body, contentHash: definitionContentHash(body) } satisfies Experiment;
    const registry = new ImmutableRegistry<Experiment>();
    registry.publish(record.experimentId, record);
    expect(() =>
      registry.publish(record.experimentId, { ...record, hypothesis: "changed" }),
    ).toThrow("content hash mismatch");
    expect(() =>
      registry.publish(record.experimentId, {
        ...record,
        contentHash: definitionContentHash({ ...body, hypothesis: "changed" }),
        hypothesis: "changed",
      }),
    ).toThrow("cannot be replaced");
  });
});
