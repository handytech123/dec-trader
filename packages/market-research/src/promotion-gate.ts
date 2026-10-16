export interface PromotionGateDecision {
  readonly eligible: boolean;
  readonly qualifyingFindingCount: number;
  readonly reasons: readonly string[];
}

type UnknownRecord = Readonly<Record<string, unknown>>;

const record = (value: unknown): UnknownRecord | undefined =>
  typeof value === "object" && value !== null ? (value as UnknownRecord) : undefined;

const intervalExcludesZero = (value: unknown): boolean => {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const lower = Number(value[0]);
  const upper = Number(value[1]);
  return Number.isFinite(lower) && Number.isFinite(upper) && (lower > 0 || upper < 0);
};

export function evaluateDevelopmentPromotionGate(result: unknown): PromotionGateDecision {
  const analysis = record(result);
  const reasons: string[] = [];
  if (analysis?.status !== "COMPLETE") reasons.push("DEVELOPMENT_ANALYSIS_INCOMPLETE");
  if (analysis?.holdoutAccessed !== false) reasons.push("DEVELOPMENT_RESULT_NOT_SEALED");
  const cells = Array.isArray(analysis?.cells) ? analysis.cells : [];
  const significant = cells
    .map(record)
    .filter(
      (cell): cell is UnknownRecord =>
        cell?.partition === "DEVELOPMENT" && cell.significant === true,
    );
  if (significant.length === 0) reasons.push("NO_SIGNIFICANT_DEVELOPMENT_FINDING");
  const qualifying = significant.filter((cell) => {
    const robustness = record(cell.robustness);
    const materiality = record(robustness?.materiality);
    const bootstrap = record(robustness?.clusterBootstrap);
    const byEpisode = record(bootstrap?.byEpisode);
    return (
      robustness?.status === "COMPLETE" &&
      robustness.overlapDependent === false &&
      materiality?.decision === "ECONOMICALLY_MATERIAL" &&
      intervalExcludesZero(byEpisode?.confidenceInterval)
    );
  });
  if (significant.length > 0 && qualifying.length === 0)
    reasons.push("FINDINGS_FAILED_ROBUSTNESS_OR_MATERIALITY");
  return { eligible: reasons.length === 0, qualifyingFindingCount: qualifying.length, reasons };
}
