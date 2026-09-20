import { z } from "zod";

export const SystemModeSchema = z.enum([
  "OFFLINE_RESEARCH",
  "SHADOW",
  "PAPER",
  "LIVE_ARMED",
  "HALTED",
]);
export type SystemMode = z.infer<typeof SystemModeSchema>;

export const EvaluationModeSchema = z.enum(["BACKTEST", "SHADOW", "PAPER", "LIVE"]);
export type EvaluationMode = z.infer<typeof EvaluationModeSchema>;

export function entryEvaluationMode(mode: SystemMode): EvaluationMode | null {
  switch (mode) {
    case "OFFLINE_RESEARCH":
      return "BACKTEST";
    case "SHADOW":
      return "SHADOW";
    case "PAPER":
      return "PAPER";
    case "LIVE_ARMED":
      return "LIVE";
    case "HALTED":
      return null;
  }
}
