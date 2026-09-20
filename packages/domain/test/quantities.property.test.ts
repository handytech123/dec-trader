import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AtomicQuantitySchema, toAtomicBigInt } from "../src/index.js";

describe("atomic quantity properties", () => {
  it("round-trips arbitrary non-negative quantities without precision loss", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n }), (value) => {
        const encoded = AtomicQuantitySchema.parse(value.toString(10));
        expect(toAtomicBigInt(encoded)).toBe(value);
      }),
    );
  });

  it.each(["-1", "01", "1.0", "1e3", "", " 1"])("rejects noncanonical value %s", (value) => {
    expect(() => AtomicQuantitySchema.parse(value)).toThrow();
  });
});
