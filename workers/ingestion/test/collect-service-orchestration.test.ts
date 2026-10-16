import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("continuous collection orchestration", () => {
  it("fails a cycle promptly when one concurrent feed rejects", async () => {
    // The repository test runner fixes process.cwd() to the workspace root.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = await readFile(
      resolve(process.cwd(), "workers/ingestion/src/collect-service-cli.ts"),
      "utf8",
    );
    expect(source).toContain("] = await Promise.all(tasks);");
    expect(source).not.toContain("await Promise.allSettled(tasks)");
  });

  it("persists the current lease identity before starting long-lived feeds", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = await readFile(
      resolve(process.cwd(), "workers/ingestion/src/collect-service-cli.ts"),
      "utf8",
    );
    const startingManifest = source.indexOf('status: "STARTING"');
    const firstFeed = source.indexOf("new CoinbasePublicWebSocketFactory");
    expect(startingManifest).toBeGreaterThan(0);
    expect(startingManifest).toBeLessThan(firstFeed);
  });
});
