import { createReadStream } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { databaseLocation, ResearchDatabase } from "@autonomous-trading-lab/ingestion";
import { runtimeAuthority } from "@autonomous-trading-lab/domain";

const root = process.env.INIT_CWD ?? process.cwd();
const publicDirectory = resolve(root, "apps/dashboard/public");
const databaseDirectory = databaseLocation(
  root,
  process.env.CFIE_DATABASE_URL ?? process.env.ATL_DATABASE ?? ".atl-data/research-db",
);
const migrationsDirectory = resolve(root, "infra/postgres/migrations");
const supervisorStatusPath = resolve(root, ".atl-data/cfie-supervisor/status.json");
const cfieReportCachePath = resolve(root, ".atl-data/cfie-supervisor/dashboard-cfie-cache.json");
const backupVerificationPath = "D:\\CFIE\\backups\\latest-verification.json";
const derivationStatusPath = resolve(
  root,
  ".atl-data/cfie-service-postgres/derivation-service.json",
);
const enrichmentReadinessPath = resolve(
  root,
  "artifacts/research/enrichment-readiness-latest.json",
);
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
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'",
    "Referrer-Policy": "no-referrer",
  });
  response.end(JSON.stringify(value));
};

const parseOperationalJson = (value: string): unknown =>
  JSON.parse(value.replace(/^\uFEFF/, "")) as unknown;

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

let entityCandidateCache:
  | {
      readonly generatedAt: string;
      readonly expiresAt: number;
      readonly candidates: readonly Record<string, unknown>[];
      readonly quality: Awaited<ReturnType<ResearchDatabase["entityAttributionQualityReport"]>>;
      readonly protocolFlow: Awaited<ReturnType<ResearchDatabase["pumpSwapFlowSummary"]>>;
      readonly protocolResearch: Awaited<ReturnType<ResearchDatabase["pumpSwapProtocolReadiness"]>>;
    }
  | undefined;

let cfieReportCache:
  | {
      readonly expiresAt: number;
      readonly report: Awaited<ReturnType<ResearchDatabase["cfieDemoReport"]>>;
    }
  | undefined;
let cfieReportInFlight:
  | Promise<Awaited<ReturnType<ResearchDatabase["cfieDemoReport"]>>>
  | undefined;

const refreshCfieReport = (): Promise<Awaited<ReturnType<ResearchDatabase["cfieDemoReport"]>>> => {
  if (cfieReportInFlight) return cfieReportInFlight;
  cfieReportInFlight = database
    .cfieDemoReport()
    .then(async (report) => {
      cfieReportCache = { expiresAt: Date.now() + 60_000, report };
      const temporaryPath = `${cfieReportCachePath}.${String(process.pid)}.tmp`;
      // Paths are fixed beneath the workspace-owned runtime directory.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await writeFile(temporaryPath, JSON.stringify(report), "utf8");
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await rename(temporaryPath, cfieReportCachePath);
      return report;
    })
    .finally(() => {
      cfieReportInFlight = undefined;
    });
  return cfieReportInFlight;
};

try {
  // Fixed workspace-owned dashboard cache path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const stored = parseOperationalJson(await readFile(cfieReportCachePath, "utf8"));
  if (
    typeof stored === "object" &&
    stored !== null &&
    "generatedAt" in stored &&
    typeof stored.generatedAt === "string"
  )
    cfieReportCache = {
      expiresAt: 0,
      report: stored as Awaited<ReturnType<ResearchDatabase["cfieDemoReport"]>>,
    };
} catch {
  // The first dashboard run has no durable cache. It will be created after the first report.
}

const getCfieReport = (): Promise<Awaited<ReturnType<ResearchDatabase["cfieDemoReport"]>>> => {
  const now = Date.now();
  if (cfieReportCache) {
    if (cfieReportCache.expiresAt <= now) void refreshCfieReport().catch(() => undefined);
    return Promise.resolve(cfieReportCache.report);
  }
  return refreshCfieReport();
};

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
  if (url.pathname === "/api/authority") {
    json(response, 200, runtimeAuthority);
    return;
  }
  if (url.pathname === "/api/cfie") {
    void getCfieReport()
      .then((report) => {
        json(response, 200, report);
      })
      .catch((error: unknown) => {
        json(response, 500, {
          error: error instanceof Error ? error.message : "Unable to read CFIE report",
        });
      });
    return;
  }
  if (url.pathname === "/api/health") {
    void database
      .operationalHealth()
      .then((health) => {
        json(response, health.status === "UNHEALTHY" ? 503 : 200, health);
      })
      .catch((error: unknown) => {
        json(response, 503, {
          error: error instanceof Error ? error.message : "Unable to read operational health",
        });
      });
    return;
  }
  if (url.pathname === "/api/filtered-alerts") {
    const requestedLimit = Number(url.searchParams.get("limit") ?? 20);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(100, Math.max(1, requestedLimit))
      : 20;
    void database
      .recentFilteredCapitalAlerts(limit)
      .then((alerts) => {
        json(response, 200, {
          authority: "READ_ONLY_EVIDENCE",
          generatedAt: new Date().toISOString(),
          alerts,
        });
      })
      .catch((error: unknown) => {
        json(response, 500, {
          error: error instanceof Error ? error.message : "Unable to read filtered alerts",
        });
      });
    return;
  }
  if (url.pathname === "/api/operations") {
    void Promise.all([
      // Both paths are fixed workspace-owned operational status files.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      readFile(supervisorStatusPath, "utf8")
        .then(parseOperationalJson)
        .catch(() => null),
      readFile(backupVerificationPath, "utf8")
        .then(parseOperationalJson)
        .catch(() => null),
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      readFile(derivationStatusPath, "utf8")
        .then(parseOperationalJson)
        .catch(() => null),
    ]).then(([supervisor, backup, derivation]) => {
      json(response, 200, {
        authority: "READ_ONLY_OPERATIONS",
        observedAt: new Date().toISOString(),
        supervisor,
        backup,
        derivation,
      });
    });
    return;
  }
  if (url.pathname === "/api/paper-lab") {
    void database
      .paperStyleLabReport()
      .then((report) => {
        json(response, 200, report);
      })
      .catch((error: unknown) => {
        json(response, 500, {
          error: error instanceof Error ? error.message : "Unable to read paper laboratory status",
        });
      });
    return;
  }
  if (url.pathname === "/api/trading-bots") {
    void database
      .tradingBotsReport()
      .then((report) => {
        json(response, 200, report);
      })
      .catch((error: unknown) => {
        json(response, 500, {
          error: error instanceof Error ? error.message : "Unable to read trading-bot status",
        });
      });
    return;
  }
  if (url.pathname === "/api/phase-two") {
    void Promise.all([database.phaseTwoResearchStatus(), database.marketResponseFailureCoverage()])
      .then(([status, responseFailureCoverage]) => {
        json(response, 200, {
          authority: "READ_ONLY_RESEARCH",
          ...status,
          responseFailureCoverage,
        });
      })
      .catch((error: unknown) => {
        json(response, 500, {
          error: error instanceof Error ? error.message : "Unable to read Phase 2 status",
        });
      });
    return;
  }
  if (url.pathname === "/api/enrichment") {
    void Promise.all([
      database.enrichmentStatus(),
      // Fixed workspace research artifact.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      readFile(enrichmentReadinessPath, "utf8")
        .then((value): unknown => JSON.parse(value) as unknown)
        .catch(() => null),
    ])
      .then(([status, readiness]) => {
        json(response, 200, { authority: "READ_ONLY_RESEARCH", ...status, readiness });
      })
      .catch((error: unknown) => {
        json(response, 500, {
          error: error instanceof Error ? error.message : "Unable to read enrichment status",
        });
      });
    return;
  }
  if (url.pathname === "/api/entity-intelligence") {
    const eventId = url.searchParams.get("eventId");
    const entityId = url.searchParams.get("entityId");
    if (!eventId || !entityId) {
      json(response, 400, { error: "eventId and entityId are required" });
      return;
    }
    void Promise.all([
      database.walletBehaviorFeature(eventId, entityId),
      database.walletBehaviorFeatureV2(eventId, entityId),
    ])
      .then(([feature, phaseTwoFeature]) => {
        json(response, 200, {
          authority: "READ_ONLY_ENTITY_INTELLIGENCE",
          feature,
          phaseTwoFeature,
        });
      })
      .catch((error: unknown) => {
        json(response, 404, {
          error: error instanceof Error ? error.message : "Unable to compute entity intelligence",
        });
      });
    return;
  }
  if (url.pathname === "/api/wallet-coverage") {
    void database
      .walletBehaviorCoverageReport()
      .then((coverage) => {
        json(response, 200, { authority: "READ_ONLY_RESEARCH", coverage });
      })
      .catch((error: unknown) => {
        json(response, 500, {
          error: error instanceof Error ? error.message : "Unable to compute wallet coverage",
        });
      });
    return;
  }
  if (url.pathname === "/api/entity-candidates") {
    const now = Date.now();
    if (entityCandidateCache && entityCandidateCache.expiresAt > now) {
      json(response, 200, {
        authority: "READ_ONLY_ENTITY_DISCOVERY",
        generatedAt: entityCandidateCache.generatedAt,
        cached: true,
        warning:
          "Behavior heuristics are not identity claims. UNKNOWN remains UNKNOWN without sourced evidence.",
        candidates: entityCandidateCache.candidates,
        quality: entityCandidateCache.quality,
        protocolFlow: entityCandidateCache.protocolFlow,
        protocolResearch: entityCandidateCache.protocolResearch,
      });
      return;
    }
    const generatedAt = new Date(now).toISOString();
    void Promise.all([
      database.entityVerificationCandidates(generatedAt, 1_000, 25),
      database.latestEntityVerificationReviews(1_000),
      database.entityAttributionQualityReport(generatedAt),
      database.pumpSwapFlowSummary(),
      database.pumpSwapProtocolReadiness(),
    ])
      .then(([discovered, reviews, quality, protocolFlow, protocolResearch]) => {
        const reviewByAddress = new Map(reviews.map((review) => [review.address, review]));
        const candidates = discovered.map((candidate) => ({
          ...candidate,
          reviewStatus: candidate.address
            ? (reviewByAddress.get(candidate.address)?.status ?? "PENDING")
            : "PENDING",
          latestReview: candidate.address ? reviewByAddress.get(candidate.address) : undefined,
        }));
        entityCandidateCache = {
          generatedAt,
          expiresAt: now + 300_000,
          candidates,
          quality,
          protocolFlow,
          protocolResearch,
        };
        json(response, 200, {
          authority: "READ_ONLY_ENTITY_DISCOVERY",
          generatedAt,
          cached: false,
          warning:
            "Behavior heuristics are not identity claims. UNKNOWN remains UNKNOWN without sourced evidence.",
          candidates,
          quality,
          protocolFlow,
          protocolResearch,
        });
      })
      .catch((error: unknown) => {
        json(response, 500, {
          error: error instanceof Error ? error.message : "Unable to discover entity candidates",
        });
      });
    return;
  }
  if (url.pathname === "/api/capital-event") {
    const eventId = url.searchParams.get("id");
    if (!eventId || !/^event_[0-9A-Z]{26}$/.test(eventId)) {
      json(response, 400, { error: "a valid capital-event id is required" });
      return;
    }
    void database
      .capitalEventDetail(eventId)
      .then((detail) => {
        if (!detail) json(response, 404, { error: "capital event not found" });
        else json(response, 200, { authority: "READ_ONLY_EVIDENCE", ...detail });
      })
      .catch((error: unknown) => {
        json(response, 500, {
          error: error instanceof Error ? error.message : "Unable to inspect capital event",
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
  // Warm and coalesce the expensive aggregate report before the first browser refresh.
  void refreshCfieReport().catch(() => undefined);
});
