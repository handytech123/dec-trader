export interface BoundStrategyEvidence {
  readonly classification: string | null;
  readonly sampleSize: number;
  readonly expectedNetBps: number | null;
  readonly replayReproducibility: number | null;
  readonly state: "BOUND" | "NO_FINDING_PACKET" | "HYPOTHESIS_MISMATCH" | "INVALID_FINDING_PACKET";
}

type UnknownRecord = Readonly<Record<string, unknown>>;

const record = (value: unknown): UnknownRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const unbound = (state: BoundStrategyEvidence["state"]): BoundStrategyEvidence => ({
  classification: null,
  sampleSize: 0,
  expectedNetBps: null,
  replayReproducibility: null,
  state,
});

/**
 * Binds only an exact strategy hypothesis and requires explicit, packet-authored trading metrics.
 * It deliberately does not infer tradability from generic statistical results.
 */
export function bindStrategyFindingPacket(
  packet: unknown,
  expectedHypothesisId: string,
): BoundStrategyEvidence {
  if (packet === null || packet === undefined) return unbound("NO_FINDING_PACKET");
  const body = record(packet);
  if (body?.packetVersion !== 1) return unbound("INVALID_FINDING_PACKET");
  if (body.hypothesisId !== expectedHypothesisId) return unbound("HYPOTHESIS_MISMATCH");
  const classification = typeof body.classification === "string" ? body.classification : null;
  const sampleSize = finite(body.observationCount);
  const development = record(body.developmentResult);
  const strategyEvidence = record(development?.strategyEvidence);
  const expectedNetBps = finite(strategyEvidence?.expectedNetBps);
  const replayReproducibility = finite(strategyEvidence?.replayReproducibility);
  if (
    classification === null ||
    sampleSize === null ||
    !Number.isInteger(sampleSize) ||
    sampleSize < 0 ||
    (expectedNetBps !== null && expectedNetBps < 0) ||
    (replayReproducibility !== null && (replayReproducibility < 0 || replayReproducibility > 1))
  )
    return unbound("INVALID_FINDING_PACKET");
  return {
    classification,
    sampleSize,
    expectedNetBps,
    replayReproducibility,
    state: "BOUND",
  };
}
