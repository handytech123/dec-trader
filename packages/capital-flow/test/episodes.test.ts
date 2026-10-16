import { describe, expect, it } from "vitest";
import {
  constructCapitalFlowEpisodes,
  defaultEpisodeConstructionConfig,
  type EpisodeInputEvent,
} from "../src/episodes.js";

const event = (overrides: Partial<EpisodeInputEvent> = {}): EpisodeInputEvent => ({
  eventId: "event_01",
  eventTime: "2026-01-01T00:00:00.000Z",
  assetId: "asset_sol",
  quantity: "10",
  sourceEntityId: "entity_a",
  destinationEntityId: "entity_b",
  sourceClass: "UNKNOWN",
  destinationClass: "CEX",
  attributionAsOf: "2026-01-01T00:00:00.000Z",
  attributionEvidenceIds: ["evidence_1"],
  transactionSucceeded: true,
  attributionAmbiguous: false,
  ...overrides,
});

describe("capital-flow episode construction v2", () => {
  it("groups only compatible directed flows within the configured gap", () => {
    const episodes = constructCapitalFlowEpisodes([
      event(),
      event({ eventId: "event_02", eventTime: "2026-01-01T00:00:20.000Z", quantity: "4" }),
      event({
        eventId: "event_03",
        eventTime: "2026-01-01T00:00:21.000Z",
        destinationEntityId: "entity_c",
      }),
    ]);
    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toMatchObject({
      eventCount: 2,
      totalQuantity: "14",
      maximumQuantity: "10",
    });
    expect(episodes[1]?.eventCount).toBe(1);
  });

  it("does not merge unrelated events merely because they are close in time", () => {
    const episodes = constructCapitalFlowEpisodes([
      event(),
      event({
        eventId: "event_02",
        eventTime: "2026-01-01T00:00:01.000Z",
        sourceEntityId: "entity_x",
      }),
    ]);
    expect(episodes).toHaveLength(2);
  });

  it("excludes failed, self, and ambiguous events while preserving unknown", () => {
    const episodes = constructCapitalFlowEpisodes([
      event({ eventId: "failed", transactionSucceeded: false }),
      event({ eventId: "self", destinationEntityId: "entity_a" }),
      event({ eventId: "ambiguous", attributionAmbiguous: true }),
      event({ eventId: "unknown", destinationClass: "UNKNOWN" }),
    ]);
    expect(episodes.map((episode) => episode.anchorEventId)).toEqual(["unknown"]);
    expect(episodes[0]?.quality).toBe("UNKNOWN_CONTEXT");
  });

  it("is deterministic and changes identity when the versioned config changes", () => {
    const input = [event()];
    const first = constructCapitalFlowEpisodes(input);
    const replay = constructCapitalFlowEpisodes([...input].reverse());
    const changed = constructCapitalFlowEpisodes(input, {
      ...defaultEpisodeConstructionConfig,
      maximumTemporalSeparationSeconds: 31,
    });
    expect(replay).toEqual(first);
    expect(changed[0]?.configHash).not.toBe(first[0]?.configHash);
    expect(changed[0]?.episodeId).not.toBe(first[0]?.episodeId);
  });
});
