import { createHash } from "node:crypto";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function deterministicDomainId(prefix: string, seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = `${alphabet.charAt(Number(value & 31n))}${encoded}`;
    value >>= 5n;
  }
  return `${prefix}_${encoded}`;
}
