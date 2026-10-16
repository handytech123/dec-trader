export type ProtocolFlowCohort =
  | "PUMPSWAP_BASELINE_IMMATURE"
  | "PUMPSWAP_FLOW_SURGE_Z_GE_3"
  | "PUMPSWAP_FLOW_SURGE_Z_GE_2"
  | "PUMPSWAP_FLOW_COLLAPSE_Z_LE_NEG_2"
  | "PUMPSWAP_FLOW_NORMAL";

export function classifyPumpSwapFlowWindow(
  priorWindowCount: number,
  eventCountZScore: number | undefined,
): ProtocolFlowCohort {
  if (!Number.isInteger(priorWindowCount) || priorWindowCount < 0)
    throw new Error("priorWindowCount must be a non-negative integer");
  if (priorWindowCount < 12 || eventCountZScore === undefined) return "PUMPSWAP_BASELINE_IMMATURE";
  if (!Number.isFinite(eventCountZScore)) throw new Error("eventCountZScore must be finite");
  if (eventCountZScore >= 3) return "PUMPSWAP_FLOW_SURGE_Z_GE_3";
  if (eventCountZScore >= 2) return "PUMPSWAP_FLOW_SURGE_Z_GE_2";
  if (eventCountZScore <= -2) return "PUMPSWAP_FLOW_COLLAPSE_Z_LE_NEG_2";
  return "PUMPSWAP_FLOW_NORMAL";
}
