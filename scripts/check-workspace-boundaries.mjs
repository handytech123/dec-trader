import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const groups = ["apps", "workers", "packages", "strategies"];
const packages = new Map();

for (const group of groups) {
  const directory = join(root, group);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const path = join(directory, entry.name, "package.json");
    try {
      const manifest = JSON.parse(await readFile(path, "utf8"));
      packages.set(manifest.name, { manifest, path });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

const violations = [];
for (const [name, { manifest }] of packages) {
  const dependencies = Object.keys(manifest.dependencies ?? {});
  if (
    name === "@autonomous-trading-lab/domain" &&
    dependencies.some((item) => item.startsWith("@autonomous-trading-lab/"))
  ) {
    violations.push("domain must not depend on another internal package");
  }
  if (
    name === "@autonomous-trading-lab/strategy-sdk" &&
    dependencies.includes("@autonomous-trading-lab/execution-contracts")
  ) {
    violations.push("strategy-sdk must not depend on execution-contracts");
  }
}

if (violations.length > 0) throw new Error(violations.join("\n"));
console.log(`Workspace boundary check passed for ${packages.size} packages.`);
