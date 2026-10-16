import { createHash } from "node:crypto";

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

function randomGenerator(seed: string): () => number {
  let state = createHash("sha256").update(seed).digest().readUInt32BE(0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

export function deterministicPermutationPValue(
  selected: readonly number[],
  baseline: readonly number[],
  permutations: number,
  seed: string,
): number | null {
  if (selected.length === 0 || baseline.length === 0) return null;
  const observed = Math.abs(mean(selected) - mean(baseline));
  const pooled = [...selected, ...baseline];
  const total = pooled.reduce((sum, value) => sum + value, 0);
  const sampleSize = Math.min(selected.length, baseline.length);
  const complementSize = pooled.length - sampleSize;
  const random = randomGenerator(seed);
  let extreme = 0;
  for (let iteration = 0; iteration < permutations; iteration += 1) {
    let sampledTotal = 0;
    const swaps = new Map<number, number>();
    for (let draw = 0; draw < sampleSize; draw += 1) {
      const candidate = draw + Math.floor(random() * (pooled.length - draw));
      const selectedIndex = swaps.get(candidate) ?? candidate;
      swaps.set(candidate, swaps.get(draw) ?? draw);
      const value = pooled.at(selectedIndex);
      if (value === undefined) throw new Error("invalid permutation index");
      sampledTotal += value;
    }
    const sampledMean = sampledTotal / sampleSize;
    const complementMean = (total - sampledTotal) / complementSize;
    if (Math.abs(sampledMean - complementMean) >= observed) extreme += 1;
  }
  return (extreme + 1) / (permutations + 1);
}
