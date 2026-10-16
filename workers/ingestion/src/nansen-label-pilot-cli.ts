import { resolve } from "node:path";
import { contentHash } from "@autonomous-trading-lab/domain";
import { finalizeEnrichmentObservation } from "@autonomous-trading-lab/enrichment";
import {
  NANSEN_COMMON_LABEL_CREDITS,
  NANSEN_PREMIUM_LABEL_CREDITS,
  NansenAccessError,
  NansenReadOnlyClient,
  nansenAddressLabelsRequest,
  parseNansenAddressLabelsResponse,
} from "@autonomous-trading-lab/nansen-provider";
import { ResearchDatabase } from "./database.js";
import { databaseLocation } from "./database-location.js";
import { deterministicDomainId } from "./ids.js";

const integerOption = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(name);
  const raw = index < 0 ? undefined : process.argv[index + 1];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
};

async function main(): Promise<void> {
  if (!process.argv.includes("--bounded-nansen-label-pilot"))
    throw new Error("--bounded-nansen-label-pilot is required");
  const premium = process.argv.includes("--premium-labels");
  if (premium && !process.argv.includes("--acknowledge-500-credit-call"))
    throw new Error("premium labels require --acknowledge-500-credit-call");
  const apiKey = process.env.NANSEN_API_KEY?.trim();
  if (!apiKey) throw new Error("NANSEN_API_KEY is not configured");
  const root = process.env.INIT_CWD ?? process.cwd();
  const observedAt = new Date().toISOString();
  const endpoint = premium ? "profiler/address/premium-labels" : "profiler/address/labels";
  const callCredits = premium ? NANSEN_PREMIUM_LABEL_CREDITS : NANSEN_COMMON_LABEL_CREDITS;
  // Allows one 100-credit common-label lookup plus the existing capped aggregate probes.
  const maximumDailyCredits = integerOption("--maximum-daily-credits", 125);
  const minimumEventCount = integerOption("--minimum-event-count", 100);
  const database = new ResearchDatabase(
    databaseLocation(root, process.env.CFIE_DATABASE_URL ?? ".atl-data/research-db"),
  );
  try {
    await database.migrate(resolve(root, "infra/postgres/migrations"));
    const dayStart = new Date(observedAt);
    dayStart.setUTCHours(0, 0, 0, 0);
    const usedToday = await database.providerCreditsUsedSince("nansen", dayStart.toISOString());
    const candidates = await database.entityVerificationCandidates(
      observedAt,
      minimumEventCount,
      100,
    );
    const candidate = candidates.find(
      (entry) => entry.identityStatus === "UNKNOWN" && entry.address !== undefined,
    );
    if (!candidate?.address) {
      process.stdout.write(
        `${JSON.stringify({ authority: "READ_ONLY_RESEARCH", status: "NO_ELIGIBLE_UNKNOWN_ADDRESS" })}\n`,
      );
      return;
    }
    const request = nansenAddressLabelsRequest({ address: candidate.address });
    const requestHash = contentHash(request);
    const cacheCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const cached = await database.cachedRawEnrichment("nansen", endpoint, requestHash, cacheCutoff);
    if (cached) {
      const cachedResponse = parseNansenAddressLabelsResponse(cached.responsePayload);
      process.stdout.write(
        `${JSON.stringify({ authority: "READ_ONLY_RESEARCH", status: "SKIPPED_30_DAY_CACHE_HIT", address: candidate.address, cachedRetrievedAt: cached.retrievedAt, creditsUsed: 0, labels: cachedResponse.data })}\n`,
      );
      return;
    }
    if (usedToday + callCredits > maximumDailyCredits) {
      process.stdout.write(
        `${JSON.stringify({ authority: "READ_ONLY_RESEARCH", status: "SKIPPED_DAILY_CREDIT_LIMIT", usedToday, callCredits, maximumDailyCredits })}\n`,
      );
      return;
    }
    const client = new NansenReadOnlyClient({ apiKey });
    let result: Awaited<ReturnType<NansenReadOnlyClient["addressLabels"]>>;
    try {
      result = await client.addressLabels({ address: candidate.address, premium, observedAt });
    } catch (error) {
      await database.persistProviderUsageMetric({
        usageId: deterministicDomainId("provider_usage", `nansen:${endpoint}:${observedAt}`),
        provider: "nansen",
        capability: endpoint,
        observedAt,
        requestCount: 1,
        cacheHitCount: 0,
        coalescedCount: 0,
        restrictedCount: error instanceof NansenAccessError ? 1 : 0,
        errorCount: 1,
        creditsUsed: callCredits,
        rateMetadata: { accounting: "CONSERVATIVE_ESTIMATE" },
      });
      throw error;
    }
    await database.persistProviderUsageMetric({
      usageId: deterministicDomainId("provider_usage", `nansen:${endpoint}:${observedAt}`),
      provider: "nansen",
      capability: endpoint,
      observedAt,
      requestCount: 1,
      cacheHitCount: 0,
      coalescedCount: 0,
      restrictedCount: 0,
      errorCount: 0,
      creditsUsed: callCredits,
      rateMetadata: { accounting: "DOCUMENTED_ENDPOINT_COST" },
    });
    const rawId = deterministicDomainId("raw_enrichment", `nansen:${result.responseHash}`);
    await database.persistRawEnrichment({
      rawEnrichmentId: rawId,
      provider: "nansen",
      capability: endpoint,
      requestHash,
      responseHash: result.responseHash,
      requestedAt: result.requestedAt,
      retrievedAt: result.receivedAt,
      requestMetadata: result.request,
      responsePayload: result.response,
      retentionBasis: "FULL_RESPONSE",
      parserVersion: 1,
    });
    let inserted = 0;
    for (const label of result.response.data) {
      const observation = finalizeEnrichmentObservation({
        observationId: deterministicDomainId(
          "enrichment",
          `nansen:${endpoint}:${candidate.address}:${label.category}:${label.label}:${result.receivedAt}`,
        ),
        rawEnrichmentId: rawId,
        provider: "nansen",
        observationType: "ADDRESS_LABEL",
        subject: candidate.address,
        chain: "solana",
        scope: premium ? "NANSEN_PREMIUM_LABEL" : "NANSEN_COMMON_LABEL",
        metric: label.category,
        value: label.label,
        unit: "LABEL",
        asOf: result.receivedAt,
        retrievedAt: result.receivedAt,
        pointInTimeEligible: true,
        retrospectiveOnly: false,
        freshnessSeconds: 0,
        quality: "VALID",
        parserVersion: 1,
      });
      if (await database.persistCanonicalEnrichment(observation)) inserted += 1;
    }
    process.stdout.write(
      `${JSON.stringify({ authority: "READ_ONLY_RESEARCH", status: "COMPLETE", address: candidate.address, endpoint, creditsUsed: callCredits, labelsReturned: result.response.data.length, labelsInserted: inserted, autoPromotedToVerifiedIdentity: false })}\n`,
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
