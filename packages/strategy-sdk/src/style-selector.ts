export type MarketRegime = "RISING" | "FALLING" | "VOLATILE" | "QUIET" | "INSUFFICIENT_DATA";

export type PaperStyleStatus = "APPROVED_FOR_PAPER" | "RESEARCH_ONLY" | "REJECTED";

export interface MarketStateSnapshot {
  readonly asOf: string;
  readonly regime: MarketRegime;
  readonly regimeConfidence: number;
  readonly liquidityScore: number;
  readonly spreadBps: number;
}

export interface PaperStyleProfile {
  readonly styleId: string;
  readonly version: string;
  readonly status: PaperStyleStatus;
  readonly supportedRegimes: readonly Exclude<MarketRegime, "INSUFFICIENT_DATA">[];
  readonly sampleSize: number;
  readonly minimumSampleSize: number;
  readonly grossExpectancyBps: number;
  readonly expectedCostBps: number;
  readonly maximumDrawdownBps: number;
  readonly minimumRegimeConfidence: number;
  readonly minimumLiquidityScore: number;
  readonly maximumSpreadBps: number;
}

export interface StyleSelectorPolicy {
  readonly policyVersion: string;
  readonly minimumDecisionScoreBps: number;
  readonly drawdownPenalty: number;
}

export interface EvaluatedPaperStyle {
  readonly styleId: string;
  readonly version: string;
  readonly eligible: boolean;
  readonly scoreBps: number | null;
  readonly reasons: readonly string[];
}

export interface StyleSelectionDecision {
  readonly mode: "PAPER_ONLY";
  readonly asOf: string;
  readonly policyVersion: string;
  readonly decision: "SELECT_STYLE" | "NO_TRADE";
  readonly selectedStyleId: string | null;
  readonly selectedStyleVersion: string | null;
  readonly scoreBps: number | null;
  readonly reasons: readonly string[];
  readonly candidates: readonly EvaluatedPaperStyle[];
}

const requireFinite = (value: number, label: string): void => {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
};

function validateMarketState(state: MarketStateSnapshot): void {
  if (!Number.isFinite(new Date(state.asOf).getTime()))
    throw new Error("invalid market-state time");
  requireFinite(state.regimeConfidence, "regime confidence");
  requireFinite(state.liquidityScore, "liquidity score");
  requireFinite(state.spreadBps, "spread");
  if (state.regimeConfidence < 0 || state.regimeConfidence > 1)
    throw new Error("regime confidence must be between zero and one");
  if (state.liquidityScore < 0 || state.liquidityScore > 1)
    throw new Error("liquidity score must be between zero and one");
  if (state.spreadBps < 0) throw new Error("spread cannot be negative");
}

function validatePolicy(policy: StyleSelectorPolicy): void {
  if (!policy.policyVersion) throw new Error("policy version is required");
  requireFinite(policy.minimumDecisionScoreBps, "minimum decision score");
  requireFinite(policy.drawdownPenalty, "drawdown penalty");
  if (policy.drawdownPenalty < 0) throw new Error("drawdown penalty cannot be negative");
}

function evaluateStyle(
  state: MarketStateSnapshot,
  profile: PaperStyleProfile,
  policy: StyleSelectorPolicy,
): EvaluatedPaperStyle {
  const reasons: string[] = [];
  if (!profile.styleId || !profile.version) throw new Error("style identity is required");
  if (!Number.isInteger(profile.sampleSize) || profile.sampleSize < 0)
    throw new Error("style sample size must be a non-negative integer");
  if (!Number.isInteger(profile.minimumSampleSize) || profile.minimumSampleSize < 1)
    throw new Error("style minimum sample size must be positive");
  for (const [label, value] of [
    ["gross expectancy", profile.grossExpectancyBps],
    ["expected cost", profile.expectedCostBps],
    ["maximum drawdown", profile.maximumDrawdownBps],
    ["minimum regime confidence", profile.minimumRegimeConfidence],
    ["minimum liquidity score", profile.minimumLiquidityScore],
    ["maximum spread", profile.maximumSpreadBps],
  ] as const)
    requireFinite(value, label);
  if (profile.expectedCostBps < 0 || profile.maximumDrawdownBps < 0)
    throw new Error("style costs and drawdown cannot be negative");
  if (
    profile.minimumRegimeConfidence < 0 ||
    profile.minimumRegimeConfidence > 1 ||
    profile.minimumLiquidityScore < 0 ||
    profile.minimumLiquidityScore > 1
  )
    throw new Error("style confidence and liquidity thresholds must be between zero and one");
  if (profile.maximumSpreadBps < 0) throw new Error("style maximum spread cannot be negative");

  if (profile.status !== "APPROVED_FOR_PAPER") reasons.push("STYLE_NOT_APPROVED_FOR_PAPER");
  if (profile.sampleSize < profile.minimumSampleSize) reasons.push("INSUFFICIENT_STYLE_SAMPLE");
  if (state.regime === "INSUFFICIENT_DATA") reasons.push("INSUFFICIENT_REGIME_DATA");
  else if (!profile.supportedRegimes.includes(state.regime)) reasons.push("REGIME_MISMATCH");
  if (state.regimeConfidence < profile.minimumRegimeConfidence)
    reasons.push("LOW_REGIME_CONFIDENCE");
  if (state.liquidityScore < profile.minimumLiquidityScore) reasons.push("LOW_LIQUIDITY");
  if (state.spreadBps > profile.maximumSpreadBps) reasons.push("SPREAD_TOO_WIDE");

  const scoreBps =
    profile.grossExpectancyBps -
    profile.expectedCostBps -
    profile.maximumDrawdownBps * policy.drawdownPenalty;
  if (scoreBps < policy.minimumDecisionScoreBps) reasons.push("INSUFFICIENT_NET_SCORE");
  return {
    styleId: profile.styleId,
    version: profile.version,
    eligible: reasons.length === 0,
    scoreBps,
    reasons,
  };
}

/**
 * Selects one empirically approved paper style or abstains. It has no proposal, wallet,
 * provider, signing, submission, or capital-allocation capability.
 */
export function selectPaperStyle(input: {
  readonly marketState: MarketStateSnapshot;
  readonly profiles: readonly PaperStyleProfile[];
  readonly policy: StyleSelectorPolicy;
}): StyleSelectionDecision {
  validateMarketState(input.marketState);
  validatePolicy(input.policy);
  const candidates = input.profiles
    .map((profile) => evaluateStyle(input.marketState, profile, input.policy))
    .sort(
      (left, right) =>
        Number(right.eligible) - Number(left.eligible) ||
        (right.scoreBps ?? Number.NEGATIVE_INFINITY) -
          (left.scoreBps ?? Number.NEGATIVE_INFINITY) ||
        left.styleId.localeCompare(right.styleId) ||
        left.version.localeCompare(right.version),
    );
  const selected = candidates.find((candidate) => candidate.eligible);
  if (!selected)
    return {
      mode: "PAPER_ONLY",
      asOf: input.marketState.asOf,
      policyVersion: input.policy.policyVersion,
      decision: "NO_TRADE",
      selectedStyleId: null,
      selectedStyleVersion: null,
      scoreBps: null,
      reasons: candidates.length === 0 ? ["NO_STYLES_CONFIGURED"] : ["NO_ELIGIBLE_STYLE"],
      candidates,
    };
  return {
    mode: "PAPER_ONLY",
    asOf: input.marketState.asOf,
    policyVersion: input.policy.policyVersion,
    decision: "SELECT_STYLE",
    selectedStyleId: selected.styleId,
    selectedStyleVersion: selected.version,
    scoreBps: selected.scoreBps,
    reasons: ["HIGHEST_ELIGIBLE_RISK_ADJUSTED_SCORE"],
    candidates,
  };
}
