import { resolve } from "node:path";

export function databaseLocation(invocationDirectory: string, candidate: string): string {
  return /^postgres(?:ql)?:\/\//i.test(candidate)
    ? candidate
    : resolve(invocationDirectory, candidate);
}

export function databaseDisplayLocation(location: string): string {
  if (!/^postgres(?:ql)?:\/\//i.test(location)) return location;
  const parsed = new URL(location);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}
