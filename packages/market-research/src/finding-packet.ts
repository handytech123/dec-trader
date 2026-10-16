import { contentHash } from "@autonomous-trading-lab/domain";

export type ResearchFindingClassification =
  | "SUPPORTED"
  | "NOT_SUPPORTED"
  | "INSUFFICIENT_DATA"
  | "INVALIDATED_DATA_QUALITY";

export interface ResearchFindingPacketBody {
  readonly packetVersion: 1;
  readonly hypothesisId: string;
  readonly protocolId: string;
  readonly runId: string;
  readonly generatedAt: string;
  readonly classification: ResearchFindingClassification;
  readonly codeHash: `sha256:${string}`;
  readonly qualityManifestId?: string | null;
  readonly datasetHash: `sha256:${string}`;
  readonly configHash: `sha256:${string}`;
  readonly observationCount: number;
  readonly episodeCount: number | null;
  readonly attributionQuality: string;
  readonly effectSizes: readonly unknown[];
  readonly confidenceIntervals: readonly unknown[];
  readonly significance: Readonly<{
    hypothesisCount: number;
    falseDiscoveryRate: number;
    correction: string;
  }>;
  readonly dependenceDiagnostics: unknown;
  readonly baselinesAndFalsification: unknown;
  readonly developmentResult: unknown;
  readonly holdoutResult: unknown;
  readonly frictionSensitivity: unknown;
  readonly contradictoryEvidence: readonly unknown[];
  readonly limitations: readonly string[];
  readonly humanReviewAction: string;
}

export type ResearchFindingPacket = ResearchFindingPacketBody & {
  readonly contentHash: `sha256:${string}`;
};

export function finalizeResearchFindingPacket(
  body: ResearchFindingPacketBody,
): ResearchFindingPacket {
  if (!Number.isInteger(body.observationCount) || body.observationCount < 0)
    throw new Error("finding packet observation count must be non-negative");
  if (!Number.isInteger(body.significance.hypothesisCount) || body.significance.hypothesisCount < 0)
    throw new Error("finding packet hypothesis count must be non-negative");
  if (!(body.significance.falseDiscoveryRate > 0 && body.significance.falseDiscoveryRate <= 0.1))
    throw new Error("finding packet FDR must be between zero and 0.1");
  if (body.humanReviewAction.trim().length === 0)
    throw new Error("finding packet requires a human-review action");
  return { ...body, contentHash: contentHash(body) };
}
