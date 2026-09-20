import { contentHash } from "@autonomous-trading-lab/domain";
import {
  MarketObservationSchema,
  RawObservationSchema,
  type MarketObservation,
  type RawObservation,
} from "./schemas.js";

export interface ObservationNormalizer {
  readonly source: string;
  normalize(observation: Readonly<RawObservation>): MarketObservation;
}

export function normalizeObservation(
  rawObservation: RawObservation,
  normalizer: ObservationNormalizer,
): MarketObservation {
  const raw = RawObservationSchema.parse(rawObservation);
  if (raw.source !== normalizer.source)
    throw new Error("normalizer source does not match observation source");
  if (contentHash(raw.payload) !== raw.payloadHash)
    throw new Error("raw provider payload hash mismatch");
  const normalized = MarketObservationSchema.parse(normalizer.normalize(structuredClone(raw)));
  if (normalized.rawObservationHash !== contentHash(raw)) {
    throw new Error("normalized observation is not bound to the raw observation");
  }
  return normalized;
}
