import { contentHash } from "@autonomous-trading-lab/domain";
import { RawObservationSchema, type RawObservation } from "./schemas.js";

export function observationDeduplicationKey(observation: RawObservation): string {
  const parsed = RawObservationSchema.parse(observation);
  return `${parsed.source}:${parsed.sourceId}:${parsed.payloadHash}`;
}

export class ObservationSet {
  readonly #byDeduplicationKey = new Map<string, RawObservation>();

  public accept(observation: RawObservation): { accepted: boolean; hash: `sha256:${string}` } {
    const parsed = RawObservationSchema.parse(observation);
    if (contentHash(parsed.payload) !== parsed.payloadHash) {
      throw new Error("raw provider payload hash mismatch");
    }
    const key = observationDeduplicationKey(parsed);
    const hash = contentHash(parsed);
    if (this.#byDeduplicationKey.has(key)) return { accepted: false, hash };
    this.#byDeduplicationKey.set(key, structuredClone(parsed));
    return { accepted: true, hash };
  }

  public ordered(): readonly RawObservation[] {
    return [...this.#byDeduplicationKey.values()]
      .sort((left, right) =>
        [left.sourceTime, left.source, left.sourceId, left.payloadHash]
          .join("\u0000")
          .localeCompare(
            [right.sourceTime, right.source, right.sourceId, right.payloadHash].join("\u0000"),
          ),
      )
      .map((value) => structuredClone(value));
  }
}
