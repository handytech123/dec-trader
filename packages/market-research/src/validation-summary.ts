export type ResearchValidationVerdict =
  | "INSUFFICIENT_DATA"
  | "PARTIAL_NO_DEVELOPMENT_FINDING"
  | "NO_DEVELOPMENT_FINDING"
  | "HOLDOUT_UNDERPOWERED"
  | "FAILED_HOLDOUT"
  | "HOLDOUT_REPLICATED";

export interface ResearchValidationSummary {
  readonly verdict: ResearchValidationVerdict;
  readonly developmentFindingCount: number;
  readonly eligibleHoldoutCount: number;
  readonly replicatedHoldoutCount: number;
}

interface ValidationCell {
  readonly horizon?: unknown;
  readonly threshold?: unknown;
  readonly cohort?: unknown;
  readonly partition?: unknown;
  readonly sampleSize?: unknown;
  readonly baselineSize?: unknown;
  readonly effectPct?: unknown;
  readonly pValue?: unknown;
  readonly significant?: unknown;
}

const cellKey = (cell: ValidationCell): string =>
  `${String(cell.horizon)}:${"threshold" in cell ? String(cell.threshold) : String(cell.cohort)}`;

export function summarizeResearchValidation(input: {
  readonly status: unknown;
  readonly minimumSampleSize: unknown;
  readonly cells: unknown;
}): ResearchValidationSummary {
  if (input.status !== "COMPLETE" || !Array.isArray(input.cells))
    return {
      verdict: "INSUFFICIENT_DATA",
      developmentFindingCount: 0,
      eligibleHoldoutCount: 0,
      replicatedHoldoutCount: 0,
    };
  const minimumSampleSize = Number(input.minimumSampleSize);
  if (!Number.isInteger(minimumSampleSize) || minimumSampleSize < 2)
    throw new Error("research result has an invalid minimum sample size");
  const cells = input.cells.filter(
    (candidate): candidate is ValidationCell => typeof candidate === "object" && candidate !== null,
  );
  const development = cells.filter(
    (cell) => cell.partition === "DEVELOPMENT" && cell.significant === true,
  );
  if (development.length === 0)
    return {
      verdict: (() => {
        const horizons = new Set(cells.map((cell) => String(cell.horizon)));
        const eligibleHorizons = new Set(
          cells
            .filter(
              (cell) =>
                cell.partition === "DEVELOPMENT" &&
                Number(cell.sampleSize) >= minimumSampleSize &&
                Number(cell.baselineSize) >= minimumSampleSize &&
                typeof cell.pValue === "number",
            )
            .map((cell) => String(cell.horizon)),
        );
        return eligibleHorizons.size < horizons.size
          ? "PARTIAL_NO_DEVELOPMENT_FINDING"
          : "NO_DEVELOPMENT_FINDING";
      })(),
      developmentFindingCount: 0,
      eligibleHoldoutCount: 0,
      replicatedHoldoutCount: 0,
    };
  const holdoutByKey = new Map(
    cells
      .filter((cell) => cell.partition === "HOLDOUT")
      .map((cell) => [cellKey(cell), cell] as const),
  );
  let eligibleHoldoutCount = 0;
  let replicatedHoldoutCount = 0;
  for (const finding of development) {
    const holdout = holdoutByKey.get(cellKey(finding));
    if (
      !holdout ||
      Number(holdout.sampleSize) < minimumSampleSize ||
      Number(holdout.baselineSize) < minimumSampleSize
    )
      continue;
    eligibleHoldoutCount += 1;
    const developmentEffect = Number(finding.effectPct);
    const holdoutEffect = Number(holdout.effectPct);
    const holdoutPValue = Number(holdout.pValue);
    if (
      Number.isFinite(developmentEffect) &&
      Number.isFinite(holdoutEffect) &&
      Number.isFinite(holdoutPValue) &&
      Math.sign(developmentEffect) === Math.sign(holdoutEffect) &&
      holdoutPValue <= 0.05
    )
      replicatedHoldoutCount += 1;
  }
  return {
    verdict:
      eligibleHoldoutCount === 0
        ? "HOLDOUT_UNDERPOWERED"
        : replicatedHoldoutCount === 0
          ? "FAILED_HOLDOUT"
          : "HOLDOUT_REPLICATED",
    developmentFindingCount: development.length,
    eligibleHoldoutCount,
    replicatedHoldoutCount,
  };
}
