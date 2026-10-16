import { describe, expect, it } from "vitest";
import { classifyPumpSwapFlowWindow } from "../src/protocol-flow.js";

describe("classifyPumpSwapFlowWindow", () => {
  it("keeps an incomplete baseline out of candidate cohorts", () => {
    expect(classifyPumpSwapFlowWindow(11, 8)).toBe("PUMPSWAP_BASELINE_IMMATURE");
    expect(classifyPumpSwapFlowWindow(12, undefined)).toBe("PUMPSWAP_BASELINE_IMMATURE");
  });

  it("classifies disjoint surge, collapse, and normal cohorts", () => {
    expect(classifyPumpSwapFlowWindow(12, 3)).toBe("PUMPSWAP_FLOW_SURGE_Z_GE_3");
    expect(classifyPumpSwapFlowWindow(12, 2.5)).toBe("PUMPSWAP_FLOW_SURGE_Z_GE_2");
    expect(classifyPumpSwapFlowWindow(12, -2)).toBe("PUMPSWAP_FLOW_COLLAPSE_Z_LE_NEG_2");
    expect(classifyPumpSwapFlowWindow(12, 0.25)).toBe("PUMPSWAP_FLOW_NORMAL");
  });

  it("rejects invalid inputs", () => {
    expect(() => classifyPumpSwapFlowWindow(-1, 0)).toThrow(/priorWindowCount/);
    expect(() => classifyPumpSwapFlowWindow(12, Number.NaN)).toThrow(/finite/);
  });
});
