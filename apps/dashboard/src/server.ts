import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { ResearchDatabase } from "@autonomous-trading-lab/ingestion";

const root = process.env.INIT_CWD ?? process.cwd();
const publicDirectory = resolve(root, "apps/dashboard/public");
const databaseDirectory = resolve(root, process.env.ATL_DATABASE ?? ".atl-data/research-db");
const migrationsDirectory = resolve(root, "infra/postgres/migrations");
const host = process.env.ATL_DASHBOARD_HOST ?? "127.0.0.1";
const port = Number(process.env.ATL_DASHBOARD_PORT ?? "4173");
const types: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const json = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
};

const serveFile = async (response: ServerResponse, pathname: string): Promise<void> => {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const path = resolve(publicDirectory, requested);
  if (!path.startsWith(`${publicDirectory}${sep}`)) {
    response.writeHead(403).end();
    return;
  }
  try {
    // Path is resolved under the fixed public directory and containment-checked above.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Type": types[extname(path)] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    createReadStream(path).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
};

if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid dashboard port");
const database = new ResearchDatabase(databaseDirectory);
await database.migrate(migrationsDirectory);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${String(port)}`);
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" }).end();
    return;
  }
  if (url.pathname === "/api/report") {
    void database
      .researchReport()
      .then((report) => {
        json(response, 200, report);
      })
      .catch((error: unknown) => {
        json(response, 500, {
          error: error instanceof Error ? error.message : "Unable to read research report",
        });
      });
    return;
  }
  void serveFile(response, url.pathname);
});

const shutdown = (): void => {
  server.close(() => {
    void database.close().finally(() => process.exit(0));
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
server.listen(port, host, () => {
  process.stdout.write(`DEX research dashboard: http://${host}:${String(port)}\n`);
});
