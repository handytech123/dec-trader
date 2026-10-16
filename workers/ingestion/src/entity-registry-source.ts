import { z } from "zod";
import { contentHash } from "@autonomous-trading-lab/domain";
import {
  VerifiedEntityAddressSchema,
  auditVerifiedEntityRegistry,
  type EntityRegistryAudit,
  type VerifiedEntityAddress,
} from "@autonomous-trading-lab/capital-flow";

const SourceRecordSchema = z
  .object({
    address: VerifiedEntityAddressSchema.shape.address,
    entityType: VerifiedEntityAddressSchema.shape.entityType,
    label: VerifiedEntityAddressSchema.shape.label,
    validFrom: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const EntityRegistrySourceSchema = z
  .object({
    sourceId: z.string().min(1).max(100),
    sourceUrl: z.url().max(2048),
    records: z.array(SourceRecordSchema).min(1).max(10_000),
  })
  .strict();

export const EntityRegistrySourceManifestSchema = z
  .object({
    manifestVersion: z.literal("1"),
    sources: z.array(EntityRegistrySourceSchema).min(1).max(100),
  })
  .strict();

export type EntityRegistrySourceManifest = z.infer<typeof EntityRegistrySourceManifestSchema>;

export interface EntityRegistrySyncResult {
  readonly records: readonly VerifiedEntityAddress[];
  readonly audit: EntityRegistryAudit;
  readonly sourcesFetched: number;
  readonly bytesFetched: number;
  readonly sourceSnapshots: readonly EntitySourceSnapshot[];
}

export interface EntitySourceSnapshot {
  readonly sourceId: string;
  readonly sourceUrl: string;
  readonly retrievedAt: string;
  readonly evidenceHash: `sha256:${string}`;
  readonly byteCount: number;
  readonly body: string;
}

export async function fetchVerifiedEntityRegistry(input: {
  readonly manifest: EntityRegistrySourceManifest;
  readonly retrievedAt: string;
  readonly fetchImplementation?: typeof fetch;
  readonly maximumSourceBytes?: number;
}): Promise<EntityRegistrySyncResult> {
  const manifest = EntityRegistrySourceManifestSchema.parse(input.manifest);
  const retrievedAt = z.iso.datetime({ offset: true }).parse(input.retrievedAt);
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const maximumSourceBytes = input.maximumSourceBytes ?? 5_000_000;
  if (
    !Number.isInteger(maximumSourceBytes) ||
    maximumSourceBytes < 1 ||
    maximumSourceBytes > 20_000_000
  )
    throw new Error("maximumSourceBytes must be between 1 and 20000000");
  const records: VerifiedEntityAddress[] = [];
  const sourceSnapshots: EntitySourceSnapshot[] = [];
  let bytesFetched = 0;
  for (const source of manifest.sources) {
    const url = new URL(source.sourceUrl);
    if (url.protocol !== "https:")
      throw new Error(`entity source must use HTTPS: ${source.sourceId}`);
    const response = await fetchImplementation(url, {
      headers: { accept: "text/plain,text/markdown,text/html,application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new Error(`entity source ${source.sourceId} returned HTTP ${String(response.status)}`);
    const body = await response.text();
    const sourceBytes = Buffer.byteLength(body, "utf8");
    if (sourceBytes > maximumSourceBytes)
      throw new Error(`entity source ${source.sourceId} exceeds the byte limit`);
    bytesFetched += sourceBytes;
    const evidenceHash = contentHash(body);
    sourceSnapshots.push({
      sourceId: source.sourceId,
      sourceUrl: source.sourceUrl,
      retrievedAt,
      evidenceHash,
      byteCount: sourceBytes,
      body,
    });
    for (const candidate of source.records) {
      if (!body.includes(candidate.address))
        throw new Error(`entity source ${source.sourceId} does not contain ${candidate.address}`);
      records.push(
        VerifiedEntityAddressSchema.parse({
          address: candidate.address,
          entityType: candidate.entityType,
          label: candidate.label,
          source: source.sourceId,
          sourceUrl: source.sourceUrl,
          evidenceHash,
          validFrom: candidate.validFrom ?? retrievedAt,
          retrievedAt,
          schemaVersion: "1",
        }),
      );
    }
  }
  return {
    records,
    audit: auditVerifiedEntityRegistry(records),
    sourcesFetched: manifest.sources.length,
    bytesFetched,
    sourceSnapshots,
  };
}
