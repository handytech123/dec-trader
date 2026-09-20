import { canonicalJson, contentHash } from "@autonomous-trading-lab/domain";
import type { Experiment, FeatureDefinition, StrategyVersion } from "./schemas.js";

type PublishedRecord = FeatureDefinition | StrategyVersion | Experiment;

export class ImmutableRegistry<T extends PublishedRecord> {
  readonly #records = new Map<string, T>();

  public publish(id: string, record: T): T {
    const { contentHash: claimedHash, ...identity } = record;
    if (contentHash(identity) !== claimedHash) {
      throw new Error(`content hash mismatch for immutable record ${id}`);
    }
    const existing = this.#records.get(id);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(record)) {
      throw new Error(`immutable record ${id} cannot be replaced`);
    }
    this.#records.set(id, structuredClone(record));
    return structuredClone(record);
  }

  public get(id: string): T | undefined {
    const value = this.#records.get(id);
    return value === undefined ? undefined : structuredClone(value);
  }
}

export function definitionContentHash(
  value:
    | Omit<FeatureDefinition, "contentHash">
    | Omit<StrategyVersion, "contentHash">
    | Omit<Experiment, "contentHash">,
): `sha256:${string}` {
  return contentHash(value);
}
