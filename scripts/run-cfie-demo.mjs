import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
const databasePath = resolve(root, ".atl-data/cfie-demo");
const seed = spawnSync(
  process.execPath,
  [resolve(root, "workers/ingestion/dist/demo-cli.js"), "--database-path", databasePath],
  { cwd: root, stdio: "inherit" },
);
if (seed.status !== 0) process.exit(seed.status ?? 1);

const dashboard = spawn(process.execPath, [resolve(root, "apps/dashboard/dist/server.js")], {
  cwd: root,
  env: { ...process.env, ATL_DATABASE: databasePath },
  stdio: "inherit",
});
const stop = () => dashboard.kill("SIGTERM");
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
dashboard.once("exit", (code) => {
  process.exitCode = code ?? 0;
});
