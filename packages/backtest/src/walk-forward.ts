export interface TimeBoundRecord {
  readonly sourceTime: string;
}
export interface WalkForwardWindow {
  readonly train: readonly TimeBoundRecord[];
  readonly validation: readonly TimeBoundRecord[];
  readonly test: readonly TimeBoundRecord[];
}

export function splitWalkForward(
  records: readonly TimeBoundRecord[],
  trainSize: number,
  validationSize: number,
  testSize: number,
): readonly WalkForwardWindow[] {
  if ([trainSize, validationSize, testSize].some((size) => !Number.isInteger(size) || size <= 0))
    throw new Error("window sizes must be positive integers");
  const ordered = [...records].sort((left, right) =>
    left.sourceTime.localeCompare(right.sourceTime),
  );
  const width = trainSize + validationSize + testSize;
  const windows: WalkForwardWindow[] = [];
  for (let offset = 0; offset + width <= ordered.length; offset += testSize) {
    const train = ordered.slice(offset, offset + trainSize);
    const validation = ordered.slice(offset + trainSize, offset + trainSize + validationSize);
    const test = ordered.slice(offset + trainSize + validationSize, offset + width);
    const trainEnd = train.at(-1)?.sourceTime;
    const validationStart = validation[0]?.sourceTime;
    const validationEnd = validation.at(-1)?.sourceTime;
    const testStart = test[0]?.sourceTime;
    if (
      trainEnd === undefined ||
      validationStart === undefined ||
      validationEnd === undefined ||
      testStart === undefined ||
      trainEnd >= validationStart ||
      validationEnd >= testStart
    )
      throw new Error("point-in-time split would leak future data");
    windows.push({ train, validation, test });
  }
  return windows;
}
