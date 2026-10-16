import { describe, expect, it } from "vitest";
import { CORE_SOLANA_PROGRAMS, filteredAccountIncludes } from "../src/filtered-stream-config.js";

describe("filtered Solana account configuration", () => {
  const manifest = {
    sources: [
      {
        records: [
          { address: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" },
          { address: "11111111111111111111111111111111" },
        ],
      },
      {
        records: [{ address: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" }],
      },
    ],
  };

  it("deduplicates and sorts verified manifest addresses", () => {
    expect(filteredAccountIncludes(manifest)).toEqual([
      "11111111111111111111111111111111",
      "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    ]);
  });

  it("optionally includes the core transfer programs", () => {
    const addresses = filteredAccountIncludes(manifest, true);
    for (const program of CORE_SOLANA_PROGRAMS) expect(addresses).toContain(program);
  });

  it("rejects empty and invalid manifests", () => {
    expect(() => filteredAccountIncludes({ sources: [] })).toThrow(/no addresses/);
    expect(() =>
      filteredAccountIncludes({ sources: [{ records: [{ address: "not-an-address" }] }] }),
    ).toThrow(/invalid Solana address/);
  });
});
