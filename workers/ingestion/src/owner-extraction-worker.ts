import type { RawBlock } from "@autonomous-trading-lab/provider-sdk";
import type { ResearchDatabase } from "./database.js";
import { extractSolanaTokenAccountOwners } from "./solana-owner-extraction.js";

export interface OwnerExtractionBatchResult {
  readonly blocksProcessed: number;
  readonly observationsFound: number;
  readonly observationsInserted: number;
  readonly remaining: boolean;
}

export async function runOwnerExtractionBatch(
  database: ResearchDatabase,
  maximumBlocks: number,
  parallelism: number,
): Promise<OwnerExtractionBatchResult> {
  if (!Number.isInteger(maximumBlocks) || maximumBlocks < 1 || maximumBlocks > 10_000)
    throw new Error("maximumBlocks must be between 1 and 10000");
  if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 16)
    throw new Error("parallelism must be between 1 and 16");
  const hashes = await database.pendingSolanaOwnerExtractionHashes(maximumBlocks);
  let nextHash = 0;
  let blocksProcessed = 0;
  let observationsFound = 0;
  let observationsInserted = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallelism, hashes.length) }, async () => {
      while (nextHash < hashes.length) {
        const index = nextHash;
        nextHash += 1;
        const hash = hashes.at(index);
        if (!hash) continue;
        const block = (await database.rawObject(hash)) as RawBlock;
        const observations = extractSolanaTokenAccountOwners(block);
        const result = await database.persistSolanaOwnerExtraction(
          hash,
          observations,
          new Date().toISOString(),
          1,
        );
        blocksProcessed += 1;
        observationsFound += result.observationCount;
        observationsInserted += result.insertedObservationCount;
      }
    }),
  );
  return {
    blocksProcessed,
    observationsFound,
    observationsInserted,
    remaining: (await database.pendingSolanaOwnerExtractionHashes(1)).length > 0,
  };
}
