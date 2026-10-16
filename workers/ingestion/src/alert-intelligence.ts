export type AlertEntityClass = "EXCHANGE" | "BRIDGE" | "PROTOCOL" | "CONTRACT" | "POOL" | "UNKNOWN";

export type CapitalFlowDirection =
  | "EXCHANGE_INFLOW"
  | "EXCHANGE_OUTFLOW"
  | "EXCHANGE_INTERNAL_OR_UNKNOWN"
  | "INTO_BRIDGE"
  | "OUT_OF_BRIDGE"
  | "PROTOCOL_INTERACTION"
  | "VERIFIED_COUNTERPARTY_TRANSFER"
  | "UNCLASSIFIED_TRANSFER";

export type WalletAnomalyLevel =
  | "INSUFFICIENT_HISTORY"
  | "NORMAL"
  | "ELEVATED"
  | "HIGH"
  | "EXTREME";

export interface AlertIntelligenceInput {
  readonly fromEntityType?: string;
  readonly toEntityType?: string;
  readonly fromLabel?: string;
  readonly toLabel?: string;
  readonly venueLabel?: string;
  readonly priorTransferCount: number;
  readonly quantityZScore?: number;
  readonly dormantDays?: number;
  readonly finalized: boolean;
  readonly normalized: boolean;
  readonly outcomeCount: number;
}

export interface AlertIntelligence {
  readonly direction: CapitalFlowDirection;
  readonly protocolAction:
    | "BRIDGE_INTERACTION"
    | "LENDING_INTERACTION"
    | "STAKING_INTERACTION"
    | "DEX_INTERACTION"
    | "PROTOCOL_INTERACTION"
    | "NONE";
  readonly walletAnomaly: WalletAnomalyLevel;
  readonly qualityScore: number;
  readonly scoreReasons: readonly string[];
}

export interface AlertIntelligenceSummary {
  readonly transferCount: number;
  readonly assetCount: number;
  readonly maxQualityScore: number;
  readonly primaryDirection: CapitalFlowDirection | "NO_TRANSFER";
  readonly primaryProtocolAction: AlertIntelligence["protocolAction"];
  readonly anomalousTransferCount: number;
  readonly matureOutcomeCount: number;
  readonly marketReactionCount: number;
  readonly maxAbsoluteZScore?: number;
}

export function summarizeAlertIntelligence(
  events: readonly {
    readonly assetId: string;
    readonly intelligence: AlertIntelligence;
    readonly outcomeCount: number;
    readonly marketReactionCount: number;
    readonly quantityZScore?: number;
  }[],
): AlertIntelligenceSummary {
  const ranked = [...events].sort(
    (left, right) => right.intelligence.qualityScore - left.intelligence.qualityScore,
  );
  const primary = ranked[0]?.intelligence;
  const zScores = events
    .map((event) => event.quantityZScore)
    .filter((value): value is number => value !== undefined)
    .map(Math.abs);
  return {
    transferCount: events.length,
    assetCount: new Set(events.map((event) => event.assetId)).size,
    maxQualityScore: primary?.qualityScore ?? 0,
    primaryDirection: primary?.direction ?? "NO_TRANSFER",
    primaryProtocolAction: primary?.protocolAction ?? "NONE",
    anomalousTransferCount: events.filter((event) =>
      ["ELEVATED", "HIGH", "EXTREME"].includes(event.intelligence.walletAnomaly),
    ).length,
    matureOutcomeCount: events.reduce((total, event) => total + event.outcomeCount, 0),
    marketReactionCount: events.reduce((total, event) => total + event.marketReactionCount, 0),
    ...(zScores.length === 0 ? {} : { maxAbsoluteZScore: Math.max(...zScores) }),
  };
}

const entityClass = (value: string | undefined): AlertEntityClass =>
  value === "EXCHANGE" ||
  value === "BRIDGE" ||
  value === "PROTOCOL" ||
  value === "CONTRACT" ||
  value === "POOL"
    ? value
    : "UNKNOWN";

export function classifyAlertIntelligence(input: AlertIntelligenceInput): AlertIntelligence {
  if (!Number.isInteger(input.priorTransferCount) || input.priorTransferCount < 0)
    throw new Error("priorTransferCount must be a non-negative integer");
  if (input.quantityZScore !== undefined && !Number.isFinite(input.quantityZScore))
    throw new Error("quantityZScore must be finite");
  if (
    input.dormantDays !== undefined &&
    (!Number.isFinite(input.dormantDays) || input.dormantDays < 0)
  )
    throw new Error("dormantDays must be a non-negative finite number");
  const from = entityClass(input.fromEntityType);
  const to = entityClass(input.toEntityType);
  const direction: CapitalFlowDirection =
    to === "EXCHANGE" && from !== "EXCHANGE"
      ? "EXCHANGE_INFLOW"
      : from === "EXCHANGE" && to !== "EXCHANGE"
        ? "EXCHANGE_OUTFLOW"
        : from === "EXCHANGE" || to === "EXCHANGE"
          ? "EXCHANGE_INTERNAL_OR_UNKNOWN"
          : to === "BRIDGE"
            ? "INTO_BRIDGE"
            : from === "BRIDGE"
              ? "OUT_OF_BRIDGE"
              : from === "PROTOCOL" || to === "PROTOCOL"
                ? "PROTOCOL_INTERACTION"
                : input.venueLabel
                  ? "PROTOCOL_INTERACTION"
                  : from !== "UNKNOWN" || to !== "UNKNOWN"
                    ? "VERIFIED_COUNTERPARTY_TRANSFER"
                    : "UNCLASSIFIED_TRANSFER";
  const context = [input.venueLabel, input.fromLabel, input.toLabel]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  const protocolAction =
    from === "BRIDGE" || to === "BRIDGE" || /bridge|wormhole|cctp|allbridge/.test(context)
      ? "BRIDGE_INTERACTION"
      : /lend|borrow|margin/.test(context)
        ? "LENDING_INTERACTION"
        : /stake|staking|marinade/.test(context)
          ? "STAKING_INTERACTION"
          : /jupiter|raydium|meteora|orca|swap|dex/.test(context)
            ? "DEX_INTERACTION"
            : from === "PROTOCOL" || to === "PROTOCOL" || input.venueLabel
              ? "PROTOCOL_INTERACTION"
              : "NONE";
  const absoluteZ = Math.abs(input.quantityZScore ?? 0);
  const dormantDays = input.dormantDays ?? 0;
  const walletAnomaly: WalletAnomalyLevel =
    input.priorTransferCount < 20
      ? "INSUFFICIENT_HISTORY"
      : absoluteZ >= 4 || dormantDays >= 30
        ? "EXTREME"
        : absoluteZ >= 3 || dormantDays >= 7
          ? "HIGH"
          : absoluteZ >= 2 || dormantDays >= 1
            ? "ELEVATED"
            : "NORMAL";
  let qualityScore = 0;
  const scoreReasons: string[] = [];
  if (input.finalized) {
    qualityScore += 20;
    scoreReasons.push("finalized on chain");
  }
  if (input.normalized) {
    qualityScore += 15;
    scoreReasons.push("canonical transfer linked");
  }
  if (from !== "UNKNOWN" || to !== "UNKNOWN") {
    qualityScore += 20;
    scoreReasons.push("verified counterparty context");
  }
  if (direction !== "UNCLASSIFIED_TRANSFER") {
    qualityScore += 10;
    scoreReasons.push("economic direction classified");
  }
  if (protocolAction !== "NONE") {
    qualityScore += 10;
    scoreReasons.push("protocol action classified");
  }
  const anomalyPoints =
    walletAnomaly === "EXTREME"
      ? 20
      : walletAnomaly === "HIGH"
        ? 15
        : walletAnomaly === "ELEVATED"
          ? 10
          : 0;
  if (anomalyPoints > 0) {
    qualityScore += anomalyPoints;
    scoreReasons.push(`${walletAnomaly.toLowerCase()} wallet anomaly`);
  }
  if (input.outcomeCount > 0) {
    qualityScore += 5;
    scoreReasons.push("market outcome available");
  }
  return {
    direction,
    protocolAction,
    walletAnomaly,
    qualityScore: Math.min(100, qualityScore),
    scoreReasons,
  };
}
