import { resolve } from "node:path";
import { ResearchDatabase } from "./database.js";

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

async function main(): Promise<void> {
  const root = process.env.INIT_CWD ?? process.cwd();
  const database = new ResearchDatabase(
    resolve(root, option("--database") ?? ".atl-data/research-db"),
  );
  try {
    await database.migrate(resolve(root, "infra/postgres/migrations"));
    process.stdout.write(`${JSON.stringify(await database.researchReport(), null, 2)}\n`);
  } finally {
    await database.close();
  }
}
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
