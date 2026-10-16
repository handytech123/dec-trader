import { z } from "zod";

export const CORE_SOLANA_PROGRAMS = [
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
] as const;

const EntityManifestSchema = z
  .object({
    sources: z.array(
      z
        .object({
          records: z.array(z.object({ address: z.string() }).loose()),
        })
        .loose(),
    ),
  })
  .loose();

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function filteredAccountIncludes(
  candidateManifest: unknown,
  includeCorePrograms = false,
): readonly string[] {
  const manifest = EntityManifestSchema.parse(candidateManifest);
  const addresses = manifest.sources.flatMap((source) =>
    source.records.map((record) => record.address),
  );
  if (includeCorePrograms) addresses.push(...CORE_SOLANA_PROGRAMS);
  const unique = [...new Set(addresses)].sort();
  if (unique.length === 0) throw new Error("filtered stream manifest contains no addresses");
  for (const address of unique) {
    if (!SOLANA_ADDRESS.test(address))
      throw new Error(`filtered stream manifest contains an invalid Solana address: ${address}`);
  }
  return unique;
}
