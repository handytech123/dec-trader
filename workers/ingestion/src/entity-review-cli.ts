import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ResearchDatabase } from "./database.js";
import { databaseDisplayLocation, databaseLocation } from "./database-location.js";
import { EntityVerificationReviewFileSchema } from "./entity-review.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  if (!process.argv.includes("--record-entity-reviews"))
    throw new Error("--record-entity-reviews is required");
  const root = process.env.INIT_CWD ?? process.cwd();
  const candidate = process.env.CFIE_DATABASE_URL ?? option("--database");
  if (!candidate) throw new Error("--database or CFIE_DATABASE_URL is required");
  const reviewFile = option("--reviews");
  if (!reviewFile) throw new Error("--reviews is required");
  const reviewPath = resolve(root, reviewFile);
  // Explicit operator-selected input; content is strictly validated before persistence.
  const parsed = EntityVerificationReviewFileSchema.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    JSON.parse(await readFile(reviewPath, "utf8")),
  );
  const location = databaseLocation(root, candidate);
  const database = new ResearchDatabase(location);
  let inserted = 0;
  try {
    await database.migrate(
      fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
    );
    for (const review of parsed.reviews)
      if (await database.persistEntityVerificationReview(review)) inserted += 1;
  } finally {
    await database.close();
  }
  process.stdout.write(
    `${JSON.stringify({
      authority: "RESEARCH_METADATA_ONLY",
      database: databaseDisplayLocation(location),
      accepted: parsed.reviews.length,
      inserted,
      warning:
        "A VERIFIED review is accepted only after matching attribution and source snapshot records exist.",
    })}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
