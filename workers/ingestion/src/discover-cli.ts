import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { discoverSolanaUniverse } from "./coingecko.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function numericOption(name: string, fallback: number): number {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

async function main(): Promise<void> {
  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  const outputPath = resolve(
    invocationDirectory,
    option("--output") ?? ".atl-data/solana-research-watchlist.json",
  );
  const watchlist = await discoverSolanaUniverse({
    minimumMarketCap: numericOption("--minimum-market-cap", 10_000_000),
    maximumMarketCap: numericOption("--maximum-market-cap", 2_000_000_000),
    minimumVolume24h: numericOption("--minimum-volume-24h", 1_000_000),
    limit: Math.floor(numericOption("--limit", 40)),
  });
  // User-selected local output is a generated research configuration, never a secret.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(dirname(outputPath), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(outputPath, `${JSON.stringify(watchlist, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ assets: watchlist.assets.length, outputPath })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
