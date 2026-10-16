import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";
import { ResearchDatabase } from "../workers/ingestion/dist/database.js";
import { drainSolanaNormalizationQueue } from "../workers/ingestion/dist/observation.js";

const [, , sourcePath, targetPath, parallelismValue = "4"] = process.argv;
if (!sourcePath || !targetPath)
  throw new Error(
    "usage: benchmark-normalization-queue.mjs <source-db> <new-target-db> [parallelism]",
  );
if (!/^postgres(?:ql)?:\/\//i.test(targetPath) && existsSync(targetPath))
  throw new Error("target database path already exists");
const parallelism = Number(parallelismValue);
if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 32)
  throw new Error("parallelism must be an integer between 1 and 32");

const source = new PGlite(sourcePath);
const objects = await source.query(
  `SELECT o.payload FROM raw_objects o
   JOIN raw_chain_blocks b ON b.raw_object_hash = o.object_hash
   ORDER BY o.object_hash LIMIT 100`,
);
await source.close();
const blocks = objects.rows.map((row) =>
  JSON.parse(gunzipSync(Buffer.from(row.payload)).toString()),
);

const database = new ResearchDatabase(targetPath);
await database.migrate(fileURLToPath(new URL("../infra/postgres/migrations/", import.meta.url)));
const storage = database.chainCollectionStorage();
const captureStarted = performance.now();
let nextBlock = 0;
await Promise.all(
  Array.from({ length: Math.min(parallelism, blocks.length) }, async () => {
    while (nextBlock < blocks.length) {
      const index = nextBlock;
      nextBlock += 1;
      // index is allocated from this same bounded local array.
      // eslint-disable-next-line security/detect-object-injection
      await storage.append(blocks[index]);
    }
  }),
);
const captureMs = performance.now() - captureStarted;
const normalizationStarted = performance.now();
const normalization = await drainSolanaNormalizationQueue(
  database,
  {
    maximumJobs: 100,
    claimBatchSize: 10,
    leaseMs: 60_000,
    maximumAttempts: 3,
    retryBackoffMs: 0,
    maximumParallelJobs: parallelism,
  },
  new globalThis.AbortController().signal,
);
const normalizationMs = performance.now() - normalizationStarted;
await database.close();

process.stdout.write(
  `${JSON.stringify({
    blocks: blocks.length,
    parallelism,
    captureMs,
    captureBlocksPerSecond: blocks.length / (captureMs / 1000),
    normalizationMs,
    normalizationBlocksPerSecond: normalization.completed / (normalizationMs / 1000),
    normalizationEventsPerSecond: normalization.capitalEvents / (normalizationMs / 1000),
    normalization,
  })}\n`,
);
