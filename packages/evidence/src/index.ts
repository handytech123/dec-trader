import { z } from "zod";
import {
  CapitalEventSchema,
  EntitySchema,
  ProvenanceSchema,
} from "@autonomous-trading-lab/capital-flow";
import { contentHash, deterministicDomainId, Sha256Schema } from "@autonomous-trading-lab/domain";

const FeatureEvidenceSchema = z
  .object({
    name: z.string().min(1),
    algorithmVersion: z.string().regex(/^[1-9][0-9]*$/),
    inputEventIds: z.array(z.string()).min(1),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  })
  .strict();

export const EvidencePacketInputSchema = z
  .object({
    generatedAt: z.iso.datetime({ offset: true }),
    detectedEvent: CapitalEventSchema,
    provenance: ProvenanceSchema,
    entities: z.array(EntitySchema),
    features: z.array(FeatureEvidenceSchema),
    historicalAnalogueCount: z.number().int().nonnegative(),
    forwardOutcomeSummary: z.record(z.string(), z.string().nullable()),
    contradictions: z.array(z.string().min(1)),
    dataQuality: z.enum(["COMPLETE", "PARTIAL", "DEGRADED"]),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type EvidencePacketInput = z.infer<typeof EvidencePacketInputSchema>;

export const EvidencePacketSchema = EvidencePacketInputSchema.extend({
  packetId: z.string(),
  packetVersion: z.literal("1"),
  action: z.literal("HUMAN_REVIEW"),
  contentHash: Sha256Schema,
}).strict();
export type EvidencePacket = z.infer<typeof EvidencePacketSchema>;

export function buildEvidencePacket(candidate: EvidencePacketInput): EvidencePacket {
  const input = EvidencePacketInputSchema.parse(candidate);
  if (input.detectedEvent.rawRef !== input.provenance.rawObjectRef)
    throw new Error("detected event is not linked to the supplied provenance");
  const body = {
    ...input,
    entities: [...input.entities].sort((left, right) =>
      left.entityId.localeCompare(right.entityId),
    ),
    features: [...input.features].sort((left, right) => left.name.localeCompare(right.name)),
    packetId: deterministicDomainId(
      "evidence",
      `${input.detectedEvent.eventId}:${input.generatedAt}`,
    ),
    packetVersion: "1" as const,
    action: "HUMAN_REVIEW" as const,
  };
  return EvidencePacketSchema.parse({ ...body, contentHash: contentHash(body) });
}
