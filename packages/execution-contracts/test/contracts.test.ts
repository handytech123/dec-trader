import { describe, expect, it } from "vitest";
import { canTransition, ExecutionAuthorizationSchema } from "../src/index.js";

describe("execution contracts", () => {
  it("requires inspection and simulation hashes for authorization", () => {
    expect(() => {
      ExecutionAuthorizationSchema.parse({
        authorizationId: "authorization_01K5J8R4K4F8D8P9Q2Z2T2H3M4",
      });
    }).toThrow();
  });

  it.each([
    ["PROPOSED", "SIGNED"],
    ["QUOTED", "AUTHORIZED"],
    ["UNKNOWN", "SIGNED"],
    ["REJECTED", "PROPOSED"],
  ] as const)("rejects transition %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it("permits the guarded preauthorization sequence", () => {
    expect(canTransition("QUOTED", "RISK_PRECHECKED")).toBe(true);
    expect(canTransition("SIMULATED", "AUTHORIZED")).toBe(true);
    expect(canTransition("AUTHORIZED", "SIGNED")).toBe(true);
  });
});
