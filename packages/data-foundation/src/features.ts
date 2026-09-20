import { contentHash } from "@autonomous-trading-lab/domain";
import type { FeatureDefinition, MarketObservation } from "./schemas.js";

export type FeatureCalculator = (
  observations: readonly MarketObservation[],
) => string | boolean | null;

export function pointInTimeObservations(
  observations: readonly MarketObservation[],
  asOf: string,
  asOfSlot?: string,
): readonly MarketObservation[] {
  const maximumSlot = asOfSlot === undefined ? undefined : BigInt(asOfSlot);
  return observations
    .filter((observation) => observation.sourceTime <= asOf)
    .filter((observation) =>
      maximumSlot === undefined || observation.slot === undefined
        ? true
        : BigInt(observation.slot) <= maximumSlot,
    )
    .sort((left, right) => left.sourceTime.localeCompare(right.sourceTime));
}

export function computeFeatureValues(
  definitions: readonly FeatureDefinition[],
  observations: readonly MarketObservation[],
  calculators: Readonly<Record<string, FeatureCalculator>>,
): {
  readonly values: Readonly<Record<string, string | boolean | null>>;
  readonly contentHash: `sha256:${string}`;
} {
  const values: Record<string, string | boolean | null> = {};
  for (const definition of [...definitions].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const calculator = calculators[definition.name];
    if (calculator === undefined) throw new Error(`missing calculator for ${definition.name}`);
    values[definition.name] = calculator(observations);
  }
  return { values, contentHash: contentHash(values) };
}
