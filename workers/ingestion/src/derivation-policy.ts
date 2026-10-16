export function shouldRefreshEntityRollup(input: {
  readonly completedCycles: number;
  readonly ownerExtractionRemaining: boolean;
  readonly completionRollupPerformed: boolean;
  readonly periodicCycleInterval?: number;
}): boolean {
  const interval = input.periodicCycleInterval ?? 120;
  if (!Number.isInteger(interval) || interval < 1)
    throw new Error("periodicCycleInterval must be positive");
  if (!input.ownerExtractionRemaining && !input.completionRollupPerformed) return true;
  return input.completedCycles > 0 && input.completedCycles % interval === 0;
}
