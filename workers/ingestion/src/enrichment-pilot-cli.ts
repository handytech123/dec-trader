import { resolve } from "node:path";
import {
  CoinGlassAccessError,
  CoinGlassReadOnlyClient,
} from "@autonomous-trading-lab/coinglass-provider";
import { contentHash } from "@autonomous-trading-lab/domain";
import {
  BoundedEnrichmentRuntime,
  finalizeEnrichmentObservation,
} from "@autonomous-trading-lab/enrichment";
import {
  NANSEN_SMART_MONEY_HOLDINGS_CREDITS,
  NansenAccessError,
  NansenReadOnlyClient,
  nansenHoldingMetrics,
  nansenSmartMoneyHoldingsRequest,
} from "@autonomous-trading-lab/nansen-provider";
import { ResearchDatabase } from "./database.js";
import { databaseLocation } from "./database-location.js";
import { deterministicDomainId } from "./ids.js";

const configured = (name: "NANSEN_API_KEY" | "COINGLASS_API_KEY"): string => {
  const value =
    name === "NANSEN_API_KEY" ? process.env.NANSEN_API_KEY : process.env.COINGLASS_API_KEY;
  if (!value?.trim()) throw new Error(`${name} is not configured`);
  return value;
};

const boundedInteger = (
  name: string,
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer between ${String(minimum)} and ${String(maximum)}`);
  return value;
};

async function main(): Promise<void> {
  if (!process.argv.includes("--bounded-enrichment-pilot"))
    throw new Error("enrichment pilot requires --bounded-enrichment-pilot");
  const root = process.env.INIT_CWD ?? process.cwd();
  const database = new ResearchDatabase(
    databaseLocation(root, process.env.CFIE_DATABASE_URL ?? ".atl-data/research-db"),
  );
  const probedAt = new Date().toISOString();
  const maximumDailyNansenCredits = boundedInteger(
    "NANSEN_MAX_DAILY_CREDITS",
    process.env.NANSEN_MAX_DAILY_CREDITS,
    25,
    0,
    10_000,
  );
  const nansenCacheTtlMinutes = boundedInteger(
    "NANSEN_CACHE_TTL_MINUTES",
    process.env.NANSEN_CACHE_TTL_MINUTES,
    360,
    5,
    10_080,
  );
  const nansen = new NansenReadOnlyClient({ apiKey: configured("NANSEN_API_KEY") });
  const includeCoinGlass = process.argv.includes("--include-coinglass");
  const coinGlass = includeCoinGlass
    ? new CoinGlassReadOnlyClient({ apiKey: configured("COINGLASS_API_KEY") })
    : undefined;
  const runtime = new BoundedEnrichmentRuntime({
    maximumRequestsPerMinute: 2,
    maximumRequestsPerDay: 24,
    maximumConcurrency: 1,
    cacheTtlMs: 60_000,
    circuitFailureThreshold: 2,
    circuitResetMs: 300_000,
  });
  try {
    await database.migrate(resolve(root, "infra/postgres/migrations"));
    const utcDayStart = new Date(probedAt);
    utcDayStart.setUTCHours(0, 0, 0, 0);
    const nansenCreditsToday = await database.providerCreditsUsedSince(
      "nansen",
      utcDayStart.toISOString(),
    );
    if (
      maximumDailyNansenCredits === 0 ||
      nansenCreditsToday + NANSEN_SMART_MONEY_HOLDINGS_CREDITS > maximumDailyNansenCredits
    ) {
      process.stdout.write(
        `${JSON.stringify({
          authority: "READ_ONLY_RESEARCH",
          holdoutAccessed: false,
          provider: "nansen",
          status: "SKIPPED_DAILY_CREDIT_LIMIT",
          creditsUsedToday: nansenCreditsToday,
          nextRequestCredits: NANSEN_SMART_MONEY_HOLDINGS_CREDITS,
          maximumDailyCredits: maximumDailyNansenCredits,
        })}\n`,
      );
      return;
    }
    const nansenRequest = nansenSmartMoneyHoldingsRequest({ chain: "solana", perPage: 10 });
    const nansenRequestHash = contentHash(nansenRequest);
    const cacheCutoff = new Date(
      new Date(probedAt).getTime() - nansenCacheTtlMinutes * 60_000,
    ).toISOString();
    const cached = await database.cachedRawEnrichment(
      "nansen",
      "smart-money/holdings",
      nansenRequestHash,
      cacheCutoff,
    );
    if (cached) {
      await database.persistProviderUsageMetric({
        usageId: deterministicDomainId("provider_usage", `nansen:cache:${probedAt}`),
        provider: "nansen",
        capability: "smart-money/holdings",
        observedAt: probedAt,
        requestCount: 0,
        cacheHitCount: 1,
        coalescedCount: 0,
        restrictedCount: 0,
        errorCount: 0,
        creditsUsed: 0,
        rateMetadata: { cacheTtlMinutes: nansenCacheTtlMinutes },
      });
      process.stdout.write(
        `${JSON.stringify({
          authority: "READ_ONLY_RESEARCH",
          holdoutAccessed: false,
          provider: "nansen",
          status: "SKIPPED_DURABLE_CACHE_HIT",
          cachedRetrievedAt: cached.retrievedAt,
          creditsUsedToday: nansenCreditsToday,
          creditsUsedThisRun: 0,
        })}\n`,
      );
      return;
    }
    let nansenResult: Awaited<ReturnType<NansenReadOnlyClient["smartMoneyHoldings"]>>;
    try {
      nansenResult = await runtime.execute("nansen:smart-money/holdings:solana:top-10", () =>
        nansen.smartMoneyHoldings({ chain: "solana", perPage: 10, observedAt: probedAt }),
      );
    } catch (error) {
      await database.persistProviderUsageMetric({
        usageId: deterministicDomainId("provider_usage", `nansen:attempt:${probedAt}`),
        provider: "nansen",
        capability: "smart-money/holdings",
        observedAt: probedAt,
        requestCount: 1,
        cacheHitCount: 0,
        coalescedCount: 0,
        restrictedCount: error instanceof NansenAccessError && error.status === 403 ? 1 : 0,
        errorCount: 1,
        // Conservatively reserve the endpoint cost even when the provider rejects the request.
        creditsUsed: NANSEN_SMART_MONEY_HOLDINGS_CREDITS,
        rateMetadata: {
          accounting: "CONSERVATIVE_ESTIMATE",
          status: error instanceof NansenAccessError ? error.status : null,
          reason: error instanceof NansenAccessError ? error.providerReason : "CLIENT_ERROR",
        },
      });
      throw error;
    }
    let coinGlassResult:
      | Awaited<ReturnType<CoinGlassReadOnlyClient["openInterestByExchange"]>>
      | undefined;
    let coinGlassReason = "HTTP_200_BOUNDED_PROBE";
    if (coinGlass) {
      const enabledCoinGlass = coinGlass;
      try {
        coinGlassResult = await runtime.execute("coinglass:open-interest:SOL", () =>
          enabledCoinGlass.openInterestByExchange("SOL", probedAt),
        );
      } catch (error) {
        if (!(error instanceof CoinGlassAccessError)) throw error;
        coinGlassReason = `${error.providerCode}:${error.providerReason}`;
      }
    } else {
      coinGlassReason = "DISABLED_BY_DEFAULT";
    }
    const probes = [
      {
        provider: "nansen" as const,
        apiVersion: "v1",
        capability: "smart-money/holdings",
        available: true,
        reason: "HTTP_200_BOUNDED_PROBE",
      },
      {
        provider: "coinglass" as const,
        apiVersion: "v4",
        capability: "futures/open-interest/exchange-list",
        available: includeCoinGlass && coinGlassResult !== undefined,
        reason: coinGlassReason,
      },
    ];
    for (const probe of probes) {
      await database.persistProviderCapabilityManifest({
        manifestId: deterministicDomainId(
          "capability_manifest",
          `${probe.provider}:${probe.apiVersion}:${probe.capability}:${probedAt}`,
        ),
        provider: probe.provider,
        apiVersion: probe.apiVersion,
        probedAt,
        capabilities: [
          { capability: probe.capability, available: probe.available, reason: probe.reason },
        ],
        rateMetadata: { exposed: false },
        parserVersion: 1,
      });
      await database.persistProviderUsageMetric({
        usageId: deterministicDomainId(
          "provider_usage",
          `${probe.provider}:${probe.capability}:${probedAt}`,
        ),
        provider: probe.provider,
        capability: probe.capability,
        observedAt: probedAt,
        requestCount: probe.provider === "coinglass" && !includeCoinGlass ? 0 : 1,
        cacheHitCount: 0,
        coalescedCount: 0,
        restrictedCount:
          probe.provider === "coinglass" && !includeCoinGlass ? 0 : probe.available ? 0 : 1,
        errorCount: 0,
        ...(probe.provider === "nansen"
          ? { creditsUsed: NANSEN_SMART_MONEY_HOLDINGS_CREDITS }
          : {}),
        rateMetadata: { exposed: false },
      });
    }
    const nansenRawId = deterministicDomainId(
      "raw_enrichment",
      `nansen:${nansenResult.responseHash}`,
    );
    await database.persistRawEnrichment({
      rawEnrichmentId: nansenRawId,
      provider: "nansen",
      capability: nansenResult.endpoint,
      requestHash: contentHash(nansenResult.request),
      responseHash: nansenResult.responseHash,
      requestedAt: nansenResult.requestedAt,
      retrievedAt: nansenResult.receivedAt,
      requestMetadata: nansenResult.request,
      responsePayload: nansenResult.response,
      retentionBasis: "FULL_RESPONSE",
      parserVersion: 1,
    });
    let canonicalCount = 0;
    for (const holding of nansenResult.response.data) {
      for (const metric of nansenHoldingMetrics(holding)) {
        const observationId = deterministicDomainId(
          "enrichment",
          `nansen:smart-money-holdings:${holding.chain}:${holding.token_address}:${metric.metric}:${nansenResult.receivedAt}`,
        );
        const observation = finalizeEnrichmentObservation({
          observationId,
          rawEnrichmentId: nansenRawId,
          provider: "nansen",
          observationType: "SMART_MONEY_HOLDINGS",
          subject: holding.token_address,
          chain: holding.chain,
          scope: `NANSEN_SMART_MONEY:${holding.token_symbol}`,
          metric: metric.metric,
          value: metric.value,
          unit: metric.unit,
          asOf: nansenResult.receivedAt,
          retrievedAt: nansenResult.receivedAt,
          pointInTimeEligible: true,
          retrospectiveOnly: false,
          freshnessSeconds: 0,
          quality: "VALID",
          parserVersion: 1,
        });
        if (await database.persistCanonicalEnrichment(observation)) canonicalCount += 1;
      }
    }
    if (coinGlassResult) {
      const coinGlassRawId = deterministicDomainId(
        "raw_enrichment",
        `coinglass:${coinGlassResult.responseHash}`,
      );
      await database.persistRawEnrichment({
        rawEnrichmentId: coinGlassRawId,
        provider: "coinglass",
        capability: coinGlassResult.endpoint,
        requestHash: contentHash({ symbol: coinGlassResult.symbol }),
        responseHash: coinGlassResult.responseHash,
        requestedAt: probedAt,
        retrievedAt: coinGlassResult.receivedAt,
        requestMetadata: { symbol: coinGlassResult.symbol },
        retentionBasis: "HASH_AND_METADATA",
        parserVersion: 1,
      });
      for (const row of coinGlassResult.data) {
        const observationId = deterministicDomainId(
          "enrichment",
          `coinglass:oi:${row.exchange}:${row.symbol}:${probedAt}`,
        );
        const observation = finalizeEnrichmentObservation({
          observationId,
          rawEnrichmentId: coinGlassRawId,
          provider: "coinglass",
          observationType: "OPEN_INTEREST",
          subject: row.symbol,
          chain: "solana",
          scope:
            row.exchange === "All" ? "COINGLASS_AGGREGATE" : `COINGLASS_EXCHANGE:${row.exchange}`,
          metric: "open_interest_usd",
          value: row.open_interest_usd,
          unit: "USD",
          asOf: probedAt,
          retrievedAt: coinGlassResult.receivedAt,
          pointInTimeEligible: true,
          retrospectiveOnly: false,
          freshnessSeconds: 10,
          quality: "VALID",
          parserVersion: 1,
        });
        if (await database.persistCanonicalEnrichment(observation)) canonicalCount += 1;
      }
    }
    process.stdout.write(
      `${JSON.stringify({
        authority: "READ_ONLY_RESEARCH",
        holdoutAccessed: false,
        configured: { NANSEN_API_KEY: true, COINGLASS_API_KEY: includeCoinGlass },
        probes: probes.map((probe) => ({
          provider: probe.provider,
          apiVersion: probe.apiVersion,
          capability: probe.capability,
          available: probe.available,
          reason: probe.reason,
        })),
        canonicalCount,
        nansenCostControl: {
          creditsUsedTodayBeforeRun: nansenCreditsToday,
          creditsUsedThisRun: NANSEN_SMART_MONEY_HOLDINGS_CREDITS,
          maximumDailyCredits: maximumDailyNansenCredits,
          durableCacheTtlMinutes: nansenCacheTtlMinutes,
        },
      })}\n`,
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
