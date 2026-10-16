import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ResearchDatabase } from "./database.js";
import { databaseLocation } from "./database-location.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  if (!process.argv.includes("--wallet-coverage"))
    throw new Error("wallet coverage report requires --wallet-coverage");
  const root = process.env.INIT_CWD ?? process.cwd();
  const minimumHistory = Number(option("--minimum-history") ?? "30");
  const outputPath = resolve(
    root,
    option("--output") ?? "artifacts/research/phase2-wallet-coverage.json",
  );
  const database = new ResearchDatabase(
    databaseLocation(
      root,
      process.env.CFIE_DATABASE_URL ?? option("--database") ?? ".atl-data/research-db",
    ),
  );
  try {
    await database.migrate(resolve(root, "infra/postgres/migrations"));
    const coverage = await database.walletBehaviorCoverageReport(
      option("--as-of") ?? new Date().toISOString(),
      minimumHistory,
    );
    const report = {
      authority: "READ_ONLY_RESEARCH",
      reportVersion: 1,
      generatedAt: new Date().toISOString(),
      interpretation:
        "Coverage describes point-in-time feature eligibility, not predictive usefulness or identity confidence.",
      coverage,
    } as const;
    // Explicit CLI-selected artifact directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(dirname(outputPath), { recursive: true });
    // Explicit CLI-selected artifact path.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
