import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ResearchDatabase } from "./database.js";
import { assessRoutes } from "./jupiter.js";
import { WatchlistSchema } from "./schemas.js";

async function main(): Promise<void> {
  const root = process.env.INIT_CWD ?? process.cwd();
  const path = resolve(root, ".atl-data/solana-research-watchlist.json");
  // This operator-owned local file is strictly schema validated.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const watchlist = WatchlistSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const results = await assessRoutes(
    watchlist.assets
      .filter((asset) => asset.researchRole === "CANDIDATE")
      .map((asset) => asset.mint),
  );
  const database = new ResearchDatabase(resolve(root, ".atl-data/research-db"));
  try {
    await database.migrate(resolve(root, "infra/postgres/migrations"));
    const assessedAt = new Date().toISOString();
    await database.persistRouteAssessments(assessedAt, results);
    const counts = results.reduce<Record<string, number>>((value, result) => {
      value[result.status] = (value[result.status] ?? 0) + 1;
      return value;
    }, {});
    process.stdout.write(`${JSON.stringify({ assessedAt, assets: results.length, counts })}\n`);
  } finally {
    await database.close();
  }
}
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
