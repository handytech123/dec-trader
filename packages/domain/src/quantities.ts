import { z } from "zod";

export const AtomicQuantitySchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, "atomic quantities must be canonical non-negative integers");
export type AtomicQuantity = z.infer<typeof AtomicQuantitySchema>;

export const DecimalSchema = z
  .string()
  // Anchored canonical decimal grammar; input length is constrained by enclosing contracts.
  // eslint-disable-next-line security/detect-unsafe-regex
  .regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/, "expected a canonical base-10 decimal");
export type Decimal = z.infer<typeof DecimalSchema>;

export function toAtomicBigInt(value: AtomicQuantity): bigint {
  return BigInt(value);
}
