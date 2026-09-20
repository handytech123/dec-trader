import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

function jsonCompatible(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonCompatible);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonCompatible(item)]),
    );
  }
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("canonical values must contain only finite numbers");
  }
  if (value === undefined) throw new TypeError("canonical values must not contain undefined");
  return value;
}

export function canonicalJson(value: unknown): string {
  const result = canonicalize(jsonCompatible(value));
  if (result === undefined) throw new TypeError("value cannot be represented as canonical JSON");
  return result;
}

export function contentHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
