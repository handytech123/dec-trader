import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = fileURLToPath(
  new URL("../packages/provider-testkit/fixtures/", import.meta.url),
);
const forbiddenKeys =
  /api[-_]?key|authorization|private[-_]?key|secret|seed|signed[-_]?transaction/i;
const files = (await readdir(fixtureRoot)).filter((file) => file.endsWith(".json"));

for (const file of files) {
  const value = JSON.parse(await readFile(join(fixtureRoot, file), "utf8"));
  if (value.provenance !== "synthetic" || value.sanitized !== true) {
    throw new Error(`${file}: fixtures must declare synthetic provenance and sanitization`);
  }
  const inspect = (item, path = "$") => {
    if (Array.isArray(item))
      return item.forEach((child, index) => inspect(child, `${path}[${index}]`));
    if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        if (forbiddenKeys.test(key))
          throw new Error(`${file}:${path}.${key}: forbidden secret-bearing field`);
        inspect(child, `${path}.${key}`);
      }
    }
  };
  inspect(value);
}

console.log(`Validated ${files.length} synthetic fixture files.`);
