import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ResearchDatabase } from "./database.js";
import { WatchlistSchema } from "./schemas.js";
import { inspectMints } from "./solana-rpc.js";

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

async function main(): Promise<void> {
  const root = process.env.INIT_CWD ?? process.cwd();
  const watchlistPath = resolve(
    root,
    option("--watchlist") ?? ".atl-data/solana-research-watchlist.json",
  );
  const database = new ResearchDatabase(
    resolve(root, option("--database") ?? ".atl-data/research-db"),
  );
  try {
    await database.migrate(resolve(root, "infra/postgres/migrations"));
    // The local path is selected by the operator and the contents are strictly parsed.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const watchlist = WatchlistSchema.parse(JSON.parse(await readFile(watchlistPath, "utf8")));
    const results = await inspectMints(
      watchlist.assets.map((asset) => asset.mint),
      option("--rpc"),
    );
    const assessedAt = new Date().toISOString();
    await database.persistTokenSafety(assessedAt, results);
    const counts = results.reduce<Record<string, number>>((total, result) => {
      total[result.assessment.status] = (total[result.assessment.status] ?? 0) + 1;
      return total;
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
