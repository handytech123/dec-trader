import { createHash } from "node:crypto";
import { z } from "zod";

// The expression is anchored and applied to small identifier inputs; nested groups cannot overlap.
// eslint-disable-next-line security/detect-unsafe-regex
const identifierPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*_[0-9A-HJKMNP-TV-Z]{26}$/;

export const DomainIdSchema = z.string().regex(identifierPattern, "expected a prefixed ULID");
export type DomainId = z.infer<typeof DomainIdSchema>;

export const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export type Sha256 = z.infer<typeof Sha256Schema>;

export const IsoTimestampSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "timestamps must be normalized to UTC (Z)");

const crockfordAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function deterministicDomainId(prefix: string, seed: string): string {
  // Anchored expression over a short internal identifier prefix.
  // eslint-disable-next-line security/detect-unsafe-regex
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(prefix))
    throw new Error("domain ID prefix must be lowercase snake case");
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = `${crockfordAlphabet.charAt(Number(value & 31n))}${encoded}`;
    value >>= 5n;
  }
  return `${prefix}_${encoded}`;
}
