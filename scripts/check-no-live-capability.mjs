import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const ignoredDirectories = new Set([
  ".git",
  ".atl-data",
  ".codex-remote-attachments",
  "artifacts",
  "coverage",
  "dist",
  "docs",
  "node_modules",
]);
const sourceExtensions = new Set([".cjs", ".js", ".mjs", ".mts", ".ts", ".tsx"]);
const policy = JSON.parse(
  await readFile(join(root, "config", "dependency-authority-policy.json"), "utf8"),
);
const authority = JSON.parse(
  await readFile(join(root, "config", "runtime-authority.json"), "utf8"),
);
const requiredDeniedCapabilities = [
  "wallet_read",
  "signing",
  "transaction_submit",
  "exchange_trade",
  "withdrawal",
  "capital_allocation",
];
const forbiddenCapabilities = [
  {
    name: "private-key environment loader",
    pattern: /process\.env\.[A-Z0-9_]*(?:PRIVATE_KEY|SECRET_KEY|MNEMONIC|SEED_PHRASE)/,
  },
  {
    name: "private-key material",
    pattern: /(?:fromSecretKey|secretKeyToAccount|privateKeyToAccount)\s*\(/,
  },
  {
    name: "keypair creation",
    pattern: /(?:Keypair|KeyPair)\.(?:generate|fromSecretKey|fromSeed)\s*\(/,
  },
  {
    name: "transaction signing",
    pattern: /\.(?:signTransaction|signAllTransactions|signAndSendTransaction)\s*\(/,
  },
  {
    name: "transaction submission",
    pattern: /\.(?:sendRawTransaction|sendTransaction|submitTransaction|broadcastTransaction)\s*\(/,
  },
  {
    name: "exchange order placement",
    pattern: /\.(?:placeOrder|createOrder|submitOrder|cancelOrder|cancelAllOrders)\s*\(/,
  },
  {
    name: "withdrawal request",
    pattern: /\.(?:withdraw|createWithdrawal|submitWithdrawal)\s*\(/,
  },
  { name: "wallet-adapter import", pattern: /from\s+["']@solana\/wallet-adapter-/ },
];

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else result.push(path);
  }
  return result;
}

const violations = [];
if (policy.policyVersion !== "1" || policy.authority !== "READ_ONLY_RESEARCH")
  violations.push("config/dependency-authority-policy.json: invalid policy identity");
if (!Array.isArray(policy.deniedDependencies) || policy.deniedDependencies.length === 0)
  violations.push("config/dependency-authority-policy.json: deniedDependencies must be non-empty");
if (authority.authority !== "READ_ONLY_RESEARCH")
  violations.push("config/runtime-authority.json: authority must be READ_ONLY_RESEARCH");
for (const capability of requiredDeniedCapabilities) {
  // Capability names come only from the fixed allowlist above.
  // eslint-disable-next-line security/detect-object-injection
  if (authority[capability] !== false)
    violations.push(`config/runtime-authority.json: ${capability} must be false`);
}
if (authority.chain_read !== true || authority.market_read !== true)
  violations.push("config/runtime-authority.json: chain_read and market_read must be true");

const inertPrefixes = policy.inertContractPaths.map((path) => path.replaceAll("/", "\\"));
for (const path of await files(root)) {
  const localPath = relative(root, path);
  const isPackageManifest = path.endsWith("package.json");
  const isSource = sourceExtensions.has(extname(path));
  if (!isPackageManifest && !isSource) continue;
  const content = await readFile(path, "utf8");
  if (isPackageManifest) {
    const manifest = JSON.parse(content);
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    };
    for (const dependency of policy.deniedDependencies) {
      if (dependency in dependencies)
        violations.push(`${localPath}: denied dependency ${dependency}`);
    }
  }
  if (!isSource) continue;
  if (localPath === "scripts\\check-no-live-capability.mjs") continue;
  if (inertPrefixes.some((prefix) => localPath.startsWith(prefix))) continue;
  for (const capability of forbiddenCapabilities) {
    if (capability.pattern.test(content))
      violations.push(`${localPath}: forbidden ${capability.name}`);
  }
}

if (violations.length > 0)
  throw new Error(`Read-only authority guard failed:\n${violations.join("\n")}`);
console.log("Read-only authority guard passed: execution authority is NONE.");
