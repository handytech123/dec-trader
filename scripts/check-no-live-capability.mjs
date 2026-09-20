import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const ignored = new Set([".git", "node_modules", "dist", "coverage", "docs"]);
const textExtensions = new Set([".ts", ".js", ".mjs", ".json", ".yaml", ".yml"]);
const forbiddenDependencies = ["@solana/web3.js", "@solana/kit", "@jup-ag/api"];
const forbiddenCapabilities = [
  /sendRawTransaction\s*\(/,
  /signTransaction\s*\(/,
  /Keypair\.generate\s*\(/,
  /fromSecretKey\s*\(/,
  /submitTransaction\s*\(/,
];

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (textExtensions.has(extname(entry.name))) result.push(path);
  }
  return result;
}

const violations = [];
for (const path of await files(root)) {
  const content = await readFile(path, "utf8");
  if (path.endsWith("package.json")) {
    const manifest = JSON.parse(content);
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const dependency of forbiddenDependencies) {
      if (dependency in dependencies) violations.push(`${relative(root, path)}: ${dependency}`);
    }
  }
  for (const pattern of forbiddenCapabilities) {
    if (pattern.test(content) && !path.endsWith("check-no-live-capability.mjs")) {
      violations.push(`${relative(root, path)}: ${String(pattern)}`);
    }
  }
}

if (violations.length > 0)
  throw new Error(`Phase 0 live-capability guard failed:\n${violations.join("\n")}`);
console.log("Phase 0 live-capability guard passed.");
