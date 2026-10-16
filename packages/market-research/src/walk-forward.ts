export interface WalkForwardObservation {
  readonly observationId: string;
  readonly observedAt: string;
  readonly candidate: boolean;
  readonly value: number;
}

export function walkForwardEffect(input: {
  readonly observations: readonly WalkForwardObservation[];
  readonly mode: "EXPANDING" | "ROLLING";
  readonly minimumDevelopmentSize: number;
  readonly evaluationWindowSize: number;
  readonly rollingDevelopmentSize?: number;
}) {
  if (!Number.isInteger(input.minimumDevelopmentSize) || input.minimumDevelopmentSize < 2)
    throw new Error("walk-forward development size must be at least two");
  if (!Number.isInteger(input.evaluationWindowSize) || input.evaluationWindowSize < 1)
    throw new Error("walk-forward evaluation window must be positive");
  if (
    input.mode === "ROLLING" &&
    (!Number.isInteger(input.rollingDevelopmentSize) ||
      (input.rollingDevelopmentSize ?? 0) < input.minimumDevelopmentSize)
  )
    throw new Error("rolling development size must cover the minimum development size");
  const observations = [...input.observations].sort(
    (left, right) =>
      left.observedAt.localeCompare(right.observedAt) ||
      left.observationId.localeCompare(right.observationId),
  );
  const effect = (values: readonly WalkForwardObservation[]) => {
    const candidate = values.filter((value) => value.candidate);
    const baseline = values.filter((value) => !value.candidate);
    if (candidate.length === 0 || baseline.length === 0) return null;
    return (
      candidate.reduce((sum, value) => sum + value.value, 0) / candidate.length -
      baseline.reduce((sum, value) => sum + value.value, 0) / baseline.length
    );
  };
  const folds = [];
  for (
    let evaluationStart = input.minimumDevelopmentSize;
    evaluationStart < observations.length;
    evaluationStart += input.evaluationWindowSize
  ) {
    const evaluationEnd = Math.min(
      observations.length,
      evaluationStart + input.evaluationWindowSize,
    );
    const developmentStart =
      input.mode === "ROLLING"
        ? Math.max(0, evaluationStart - (input.rollingDevelopmentSize ?? evaluationStart))
        : 0;
    const development = observations.slice(developmentStart, evaluationStart);
    const evaluation = observations.slice(evaluationStart, evaluationEnd);
    const developmentEffect = effect(development);
    const evaluationEffect = effect(evaluation);
    folds.push({
      fold: folds.length + 1,
      developmentStart: development.at(0)?.observedAt ?? null,
      developmentEnd: development.at(-1)?.observedAt ?? null,
      evaluationStart: evaluation.at(0)?.observedAt ?? null,
      evaluationEnd: evaluation.at(-1)?.observedAt ?? null,
      developmentCount: development.length,
      evaluationCount: evaluation.length,
      developmentEffect,
      evaluationEffect,
      directionStable:
        developmentEffect !== null &&
        evaluationEffect !== null &&
        Math.sign(developmentEffect) === Math.sign(evaluationEffect),
    });
  }
  const evaluable = folds.filter(
    (fold) => fold.developmentEffect !== null && fold.evaluationEffect !== null,
  );
  return {
    mode: input.mode,
    minimumDevelopmentSize: input.minimumDevelopmentSize,
    evaluationWindowSize: input.evaluationWindowSize,
    foldCount: folds.length,
    evaluableFoldCount: evaluable.length,
    stableDirectionFraction:
      evaluable.length === 0
        ? null
        : evaluable.filter((fold) => fold.directionStable).length / evaluable.length,
    folds,
  };
}
