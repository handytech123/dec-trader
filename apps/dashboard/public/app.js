const state = {
  report: null,
  filter: "all",
  cfieSample: null,
  refreshing: false,
  filteredAlerts: [],
};
const $ = (selector) => document.querySelector(selector);
const money = (value, digits = 0) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
  }).format(Number(value ?? 0));
const compact = (value) =>
  new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    Number(value ?? 0),
  );
const pct = (value) =>
  value == null ? "—" : `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}%`;
const safe = (value) =>
  String(value ?? "").replace(
    /[&<>'"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char],
  );
const gateClass = (status) =>
  status === "PASS" ? "pass" : status === "REVIEW" ? "review" : "block";

function renderMetrics(report) {
  const p = report.paperPortfolio;
  const cards = [
    [
      "Research eligible",
      report.researchEligible,
      `${report.candidates.length} candidates evaluated`,
    ],
    ["Paper portfolio", money(p.net_pnl, 2), `${p.open} open · ${p.closed} closed`],
    ["Forward outcomes", compact(report.health.forwardOutcomes), "Matured labels for validation"],
    [
      "Market regime",
      report.marketRegime.status,
      `SOL 1h ${pct(report.marketRegime.benchmarkReturn1hPct)}`,
    ],
  ];
  $("#metrics").innerHTML = cards
    .map(
      ([label, value, note]) =>
        `<article class="metric"><div class="label">${safe(label)}</div><div class="value">${safe(value)}</div><div class="note">${safe(note)}</div></article>`,
    )
    .join("");
}
function renderCandidates(report) {
  const rows = report.candidates.filter(
    (row) => state.filter === "all" || row.decision === state.filter,
  );
  $("#candidate-rows").innerHTML =
    rows
      .map((row) => {
        const oneHour = row.features?.return1hPct;
        const gates = [row.safetyStatus, row.routeStatus, row.integrityStatus];
        return `<tr><td><div class="asset"><span class="token">${safe(row.symbol?.slice(0, 2) || "?")}</span><div><strong>${safe(row.symbol || "Unknown")}</strong><small>${safe(row.mint.slice(0, 4))}…${safe(row.mint.slice(-4))}</small></div></div></td><td><span class="category">${safe(row.category)}</span></td><td><span class="badge ${row.decision === "RESEARCH_ELIGIBLE" ? "pass" : "block"}">${row.decision === "RESEARCH_ELIGIBLE" ? "ELIGIBLE" : "EXCLUDED"}</span>${row.blockers?.length ? `<div class="blockers">${safe(row.blockers.slice(0, 2).join(" · "))}</div>` : ""}</td><td><div class="gates" aria-label="Safety ${safe(row.safetyStatus)}, route ${safe(row.routeStatus)}, integrity ${safe(row.integrityStatus)}">${gates.map((gate) => `<span class="gate ${gateClass(gate)}"></span>`).join("")}</div></td><td>${money(row.liquidityUsd)}</td><td>${money(row.volume24h)}</td><td class="${Number(oneHour) >= 0 ? "positive" : "negative"}">${pct(oneHour)}</td><td>${row.roundTripLossBps == null ? "—" : `${Number(row.roundTripLossBps).toFixed(1)} bps`}</td></tr>`;
      })
      .join("") || `<tr><td colspan="8" class="empty">No candidates match this filter.</td></tr>`;
}
function renderPositions(report) {
  const symbols = new Map(report.candidates.map((row) => [row.mint, row.symbol]));
  $("#positions-grid").innerHTML =
    report.openPaperPositions
      .map((position) => {
        const pnl = Number(position.estimatedNetPnlUsd);
        return `<article class="position"><div class="position-top"><div><div class="symbol">${safe(symbols.get(position.mint) || position.mint.slice(0, 6))}</div><div class="category">${safe(position.strategyVersion)}</div></div><span class="badge pass">OPEN · PAPER</span></div><div class="position-stats"><div><div class="label">Estimated net P&amp;L</div><div class="pnl ${pnl >= 0 ? "positive" : "negative"}">${money(pnl, 2)}</div></div><div class="gates">${Object.values(
          position.currentGates,
        )
          .map((gate) => `<span class="gate ${gateClass(gate)}"></span>`)
          .join(
            "",
          )}</div></div><div class="position-meta"><div><small>Entry</small>${money(position.entryPrice, 6)}</div><div><small>Current</small>${money(position.currentPrice, 6)}</div><div><small>Notional</small>${money(position.notionalUsd)}</div></div></article>`;
      })
      .join("") || `<p class="empty">No open paper positions.</p>`;
}
function renderHealth(report) {
  const h = report.health;
  const values = [
    ["Observations", h.observations],
    ["Features", h.featureSnapshots],
    ["Outcomes", h.forwardOutcomes],
    ["Pools", h.pools],
    ["Route checks", h.routeAssessments],
    ["Integrity checks", h.integrityAssessments],
  ];
  $("#health-grid").innerHTML = values
    .map(
      ([label, value]) =>
        `<div class="health-item"><span class="label">${label}</span><strong>${Number(value).toLocaleString()}</strong></div>`,
    )
    .join("");
  const safety = report.latestSafety;
  const total = Object.values(safety).reduce((sum, value) => sum + value, 0);
  $("#safety-bars").innerHTML = ["PASS", "REVIEW", "BLOCK"]
    .map(
      (key) =>
        `<div class="bar"><span>${key}</span><div class="track"><div class="fill ${key.toLowerCase()}" style="width:${total ? (safety[key] / total) * 100 : 0}%"></div></div><strong>${safety[key] ?? 0}</strong></div>`,
    )
    .join("");
  const codes = Object.entries(report.collectionErrorCodes || {})
    .map(([code, count]) => `${code}: ${count}`)
    .join(" · ");
  $("#errors").textContent = codes
    ? `Collection exceptions · ${codes}`
    : "No collection exceptions recorded.";
}
function render(report) {
  state.report = report;
  $("#mode").textContent = report.mode;
  $("#updated").textContent =
    `Updated ${new Date(report.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
  renderMetrics(report);
  renderCandidates(report);
  renderPositions(report);
  renderHealth(report);
}
function renderProgress(report) {
  const service = report.collectionService;
  const now = Date.now();
  const leaseActive =
    service.status === "RUNNING" &&
    service.leaseExpiresAt &&
    new Date(service.leaseExpiresAt).getTime() > now;
  const health = report.operationalHealth;
  const stateClass = leaseActive
    ? health.status === "HEALTHY"
      ? "running"
      : "degraded"
    : service.status === "FAILED"
      ? "failed"
      : "degraded";
  const title = leaseActive
    ? health.status === "HEALTHY"
      ? "Collecting synchronized live observations"
      : "Collector is running with data-quality warnings"
    : service.status === "FAILED"
      ? "Collector stopped after an error"
      : "Collector is not currently running";
  const detail = leaseActive
    ? `${safe(service.serviceName || "CFIE observer")} · chain ${health.chainAgeSeconds === undefined ? "waiting" : `${Math.round(health.chainAgeSeconds)}s old`} · market ${health.marketAgeSeconds === undefined ? "waiting" : `${Math.round(health.marketAgeSeconds)}s old`}`
    : service.lastError
      ? safe(service.lastError)
      : "Historical data is safe. Start the read-only collector to accumulate synchronized evidence.";
  $("#collector-badge").textContent = leaseActive ? health.status : service.status;
  $("#progress-summary").className = `status-banner ${stateClass}`;
  $("#progress-summary").innerHTML =
    `<span class="pulse"></span><div><strong>${safe(title)}</strong><small>${detail}</small></div><time>${service.heartbeatAt ? `Heartbeat ${new Date(service.heartbeatAt).toLocaleTimeString()}` : "No heartbeat recorded"}</time>`;

  const previous = state.cfieSample;
  const sampleTime = Date.now();
  const elapsedMinutes = previous ? Math.max((sampleTime - previous.at) / 60_000, 1 / 60) : 0;
  const rate = (key) =>
    previous
      ? Math.max(0, (Number(report.counts[key]) - previous.counts[key]) / elapsedMinutes)
      : 0;
  const oneMinute = report.horizonMaturation.find((item) => item.horizon === "1m");
  const benchmarkCoverage = oneMinute?.outcomeCount
    ? (100 * oneMinute.benchmarkOutcomeCount) / oneMinute.outcomeCount
    : 0;
  const regime = report.latestMarketRegime;
  const readiness = [
    [
      "Independent episodes",
      compact(report.episodeReadiness.episodeCount),
      `${compact(report.episodeReadiness.underlyingEventCount)} transfers grouped · ${compact(report.episodeReadiness.attributedEpisodeCount)} with verified protocol context`,
    ],
    [
      "Observation rate",
      previous ? `${compact(rate("capitalEvents"))}/min` : "Measuring…",
      `${compact(report.counts.capitalEvents)} capital events`,
    ],
    [
      "Labeling rate",
      previous ? `${compact(rate("capitalEventForwardOutcomes"))}/min` : "Measuring…",
      `${compact(report.counts.capitalEventForwardOutcomes)} outcomes`,
    ],
    [
      "BTC-control coverage",
      `${benchmarkCoverage.toFixed(1)}%`,
      `${compact(oneMinute?.benchmarkOutcomeCount || 0)} of ${compact(oneMinute?.outcomeCount || 0)} 1m labels`,
    ],
    [
      "Market regime",
      regime?.state || "WAITING",
      regime
        ? `${regime.sampleSize} point-in-time samples · ${pct(regime.returnPct)}`
        : "Needs one hour of published reference prices",
    ],
  ];
  $("#research-readiness").innerHTML = readiness
    .map(
      ([label, value, note]) =>
        `<article class="metric"><div class="label">${safe(label)}</div><div class="value">${safe(value)}</div><div class="note">${safe(note)}</div></article>`,
    )
    .join("");
  state.cfieSample = {
    at: sampleTime,
    counts: {
      capitalEvents: Number(report.counts.capitalEvents),
      capitalEventForwardOutcomes: Number(report.counts.capitalEventForwardOutcomes),
    },
  };

  const target = 100;
  $("#horizon-progress").innerHTML = report.horizonMaturation
    .map((item) => {
      const paired = Math.min(item.outcomeCount, item.uniqueReactionTimestampCount);
      const progress = Math.min(100, (paired / target) * 100);
      const status = paired >= target ? "INITIAL READY" : "COLLECTING";
      return `<div class="horizon-row"><strong>${safe(item.horizon)} <span class="readiness-state">${status}</span></strong><div class="track" title="${paired} unique-time reaction observations toward an initial ${target}-sample research target"><div class="fill" style="width:${progress}%"></div></div><small>${compact(item.outcomeCount)} outcomes · ${compact(item.filteredOutcomeCount || 0)} watched</small><small>${compact(item.uniqueReactionTimestampCount)} unique reaction times (${compact(item.reactionCount)} records) · ${compact(item.filteredReactionCount || 0)} watched</small><small>${compact(item.benchmarkOutcomeCount)} BTC controls</small></div>`;
    })
    .join("");

  const counts = report.counts;
  const checks = [
    [counts.chainBlocks > 0, "Solana ingestion", `${compact(counts.chainBlocks)} finalized blocks`],
    [
      counts.marketEvents > 0,
      "Market ingestion",
      `${compact(counts.marketEvents)} canonical events`,
    ],
    [
      counts.referencePriceSnapshots > 0,
      "Reference prices",
      `${compact(counts.referencePriceSnapshots)} evidence-backed estimates`,
    ],
    [
      counts.verifiedEntityAddresses > 0,
      "Entity registry",
      `${compact(counts.verifiedEntityAddresses)} verified addresses`,
    ],
    [
      counts.capitalEventForwardOutcomes > 0,
      "Forward outcomes",
      `${compact(counts.capitalEventForwardOutcomes)} matured labels`,
    ],
    [
      counts.marketReactionFeatures > 0,
      "Market reactions",
      counts.marketReactionFeatures > 0
        ? `${compact(counts.marketReactionFeatures)} synchronized windows`
        : "Waiting for overlapping chain and order-book windows",
    ],
    [
      counts.marketRegimeSnapshots > 0,
      "Point-in-time regimes",
      counts.marketRegimeSnapshots > 0
        ? `${compact(counts.marketRegimeSnapshots)} immutable classifications`
        : "Waiting for the next collection cycle",
    ],
    [
      counts.capitalFlowEpisodes > 0,
      "Independent flow episodes",
      counts.capitalFlowEpisodes > 0
        ? `${compact(counts.capitalFlowEpisodes)} closed time windows`
        : "Waiting for the first finalized window",
    ],
  ];
  $("#pipeline-checklist").innerHTML = checks
    .map(
      ([ready, label, note]) =>
        `<div class="check-item ${ready ? "" : "wait"}"><i>${ready ? "✓" : "·"}</i><div><strong>${safe(label)}</strong><small>${safe(note)}</small></div></div>`,
    )
    .join("");
  const incidents = report.recentIncidentSummary || [];
  const incidentMarkup = incidents.length
    ? incidents
        .map(
          (incident) =>
            `<div class="check-item wait"><i>!</i><div><strong>${safe(incident.venue)} · ${safe(incident.productId)}</strong><small>${safe(incident.incidentType)} · ${incident.count} occurrence${incident.count === 1 ? "" : "s"} · latest ${new Date(incident.lastDetectedAt).toLocaleTimeString()}</small></div></div>`,
        )
        .join("")
    : `<div class="check-item"><i>✓</i><div><strong>No recent feed incidents</strong><small>All observed feeds have remained continuous for the last hour.</small></div></div>`;
  const gaps = report.collectionGapSummary || {};
  const gapMarkup =
    Number(gaps.gapCount || 0) > 0
      ? `<div class="check-item wait"><i>!</i><div><strong>Known chain coverage gaps</strong><small>${compact(gaps.gapCount)} recorded intervals · ${compact(gaps.skippedSlotCount)} skipped slots · largest ${compact(gaps.largestGapSlots)} slots${gaps.latestDetectedAt ? ` · latest ${new Date(gaps.latestDetectedAt).toLocaleString()}` : ""}. Research must treat these periods as incomplete.</small></div></div>`
      : `<div class="check-item"><i>✓</i><div><strong>No recorded chain gaps</strong><small>No skipped Solana slot intervals are currently recorded.</small></div></div>`;
  $("#incident-summary").innerHTML = `${incidentMarkup}${gapMarkup}`;
}
function renderOperations(report) {
  const supervisor = report.supervisor || {};
  const backup = report.backup;
  const derivation = report.derivation;
  const backupAgeHours = backup?.verifiedAt
    ? (Date.now() - new Date(backup.verifiedAt).getTime()) / 3_600_000
    : null;
  const cards = [
    [
      "Supervisor",
      supervisor.collectorRunning && supervisor.deriverRunning && supervisor.dashboardRunning
        ? "RUNNING"
        : "ATTENTION",
      supervisor.observedAt
        ? `Checked ${new Date(supervisor.observedAt).toLocaleTimeString()}`
        : "No supervisor status file",
    ],
    [
      "Solana provider",
      supervisor.solanaRpcProvider || "UNKNOWN",
      supervisor.solanaRpcCredentialConfigured
        ? "Protected credential loaded by the supervisor"
        : "Public fallback RPC · no provider credential loaded",
    ],
    [
      "Data processing",
      supervisor.deriverRunning ? "RUNNING" : "STOPPED",
      derivation
        ? `${compact(derivation.completedCycles)} cycles · ${compact(derivation.latestCycle?.ownerExtraction?.observationsInserted || 0)} owner observations in latest cycle`
        : "Capture and heavy derivation run as separately supervised processes",
    ],
    [
      "Research refresh",
      supervisor.researchRunning ? "ANALYZING" : "SCHEDULED",
      supervisor.lastResearchStart
        ? `Development-only run started ${new Date(supervisor.lastResearchStart).toLocaleString()}`
        : "Awaiting first development-only refresh",
    ],
    [
      "Free storage",
      supervisor.storageFreeGiB == null
        ? "—"
        : `${Number(supervisor.storageFreeGiB).toFixed(1)} GiB`,
      `${supervisor.storageStatus || "UNKNOWN"} · critical at ${supervisor.storageCriticalFreeGiB ?? "—"} GiB`,
    ],
    [
      "Storage forecast",
      supervisor.estimatedDaysToCritical == null
        ? "Measuring…"
        : `${Number(supervisor.estimatedDaysToCritical).toFixed(1)} days`,
      supervisor.storageDrainGiBPerDay == null
        ? "Needs a stable ten-minute measurement window"
        : `${Number(supervisor.storageDrainGiBPerDay).toFixed(2)} GiB/day observed drain`,
    ],
    [
      "Latest backup",
      backup?.archiveListing === "PASS" && backup?.dataStream === "PASS"
        ? "VERIFIED"
        : "NOT VERIFIED",
      backupAgeHours == null
        ? "Run the read-only backup verifier"
        : `${backupAgeHours.toFixed(1)}h ago · ${(Number(backup.bytes) / 1_073_741_824).toFixed(2)} GiB`,
    ],
  ];
  $("#operations-health").innerHTML = cards
    .map(
      ([label, value, note]) =>
        `<article class="metric"><div class="label">${safe(label)}</div><div class="value">${safe(value)}</div><div class="note">${safe(note)}</div></article>`,
    )
    .join("");
}
function renderPaperLab(report) {
  const counts = report.counts || {};
  const selection = report.latestSelection;
  const marketState = selection?.market_state || {};
  const cards = [
    ["Mode", report.mode || "PAPER_ONLY", "No wallet, signing, submission, or capital authority"],
    ["Style profiles", compact(counts.profiles || 0), "Immutable trained style snapshots"],
    ["Coordinator decisions", compact(counts.selections || 0), "Every abstention is retained"],
    ["Paper fills", compact(counts.fills || 0), "Simulated fills only"],
    [
      "Paper positions",
      `${compact(counts.open_positions || 0)} open`,
      `${compact(counts.closed_positions || 0)} closed automatically`,
    ],
    [
      "Market regime",
      marketState.regime || "WAITING",
      `Confidence ${Number(marketState.regimeConfidence || 0).toFixed(2)}`,
    ],
  ];
  $("#paper-lab-metrics").innerHTML = cards
    .map(
      ([label, value, note]) =>
        `<article class="metric"><div class="label">${safe(label)}</div><div class="value">${safe(value)}</div><div class="note">${safe(note)}</div></article>`,
    )
    .join("");
  $("#paper-style-library").innerHTML =
    (report.latestProfiles || [])
      .map((item) => {
        const profile = item.profile || {};
        const metrics = item.metrics || {};
        const validation = metrics.validation || {};
        const flow = metrics.flowCoverage || {};
        return `<div class="event"><span class="event-type ${item.status === "APPROVED_FOR_PAPER" ? "buy" : "sell"}">${safe(item.status)}</span><div><strong>${safe(item.style_id)} · ${safe(item.style_version)}</strong><small>${compact(profile.sampleSize || 0)} samples · ${safe(item.validation_verdict)} · ${compact(validation.evaluationTradeCount || 0)} OOS trades · CFIE flow coverage ${compact(flow.protocolFlowObservationCount || 0)} protocol / ${compact(flow.capitalFlowObservationCount || 0)} capital · gross ${Number(profile.grossExpectancyBps || 0).toFixed(2)} bps · costs ${Number(profile.expectedCostBps || 0).toFixed(2)} bps</small></div><time>${new Date(item.trained_at).toLocaleTimeString()}</time></div>`;
      })
      .join("") ||
    `<p class="empty">Run the paper laboratory to train the first style profiles.</p>`;
  $("#paper-lab-decision").innerHTML = selection
    ? `<div class="check-item ${selection.decision === "SELECT_STYLE" ? "" : "wait"}"><i>${selection.decision === "SELECT_STYLE" ? "✓" : "·"}</i><div><strong>${safe(selection.decision === "SELECT_STYLE" ? selection.selected_style_id : "NO TRADE")}</strong><small>${safe((selection.reasons || []).join(" · "))} · ${new Date(selection.as_of).toLocaleString()}</small></div></div>`
    : `<p class="empty">No coordinator decision has been recorded.</p>`;
}
function renderTradingBots(report) {
  const strategy = report.strategy || {};
  const pipeline = report.pipeline || {};
  const cards = [
    [
      "Authority",
      report.authority || "PAPER_ONLY_NO_EXECUTION",
      "Wallet and order access disabled",
    ],
    ["Verified snapshots", compact(strategy.snapshots || 0), "Point-in-time inputs accepted"],
    [
      "Strategy evaluations",
      compact(strategy.evaluations || 0),
      `${compact(strategy.proposals || 0)} proposals`,
    ],
    [
      "Paper pipeline runs",
      compact(pipeline.runs || 0),
      `${compact(pipeline.simulated || 0)} simulated and reconciled`,
    ],
  ];
  $("#trading-bot-metrics").innerHTML = cards
    .map(
      ([label, value, note]) =>
        `<article class="metric"><div class="label">${safe(label)}</div><div class="value">${safe(value)}</div><div class="note">${safe(note)}</div></article>`,
    )
    .join("");
  const values = [
    [
      "Strategy queue",
      `${compact(strategy.pending || 0)} pending · ${compact(strategy.processing || 0)} processing`,
    ],
    ["Strategy failures", compact(strategy.failed || 0)],
    [
      "Pipeline queue",
      `${compact(pipeline.pending || 0)} pending · ${compact(pipeline.processing || 0)} processing`,
    ],
    [
      "Pipeline outcomes",
      `${compact(pipeline.rejected || 0)} rejected · ${compact(pipeline.halted || 0)} halted`,
    ],
    ["Pipeline failures", compact(pipeline.failed || 0)],
  ];
  $("#trading-bot-status").innerHTML = values
    .map(
      ([label, value]) =>
        `<div class="health-item"><span class="label">${safe(label)}</span><strong>${safe(value)}</strong></div>`,
    )
    .join("");
}
function renderPhaseTwo(report) {
  const finding = report.findingSummary || {};
  const sealed = report.sealedEpisodeProtocol;
  const readiness = report.episodeReadiness || { gates: [] };
  $("#phase-two-status").innerHTML = [
    ["Episode protocol", sealed ? `v${sealed.version} ${sealed.status}` : "NOT REGISTERED"],
    [
      "Sealed cutoff",
      sealed ? new Date(sealed.datasetCutoff).toLocaleDateString() : "NOT REGISTERED",
    ],
    ["Research verdict", finding.verdict || "NO FINDINGS"],
    [
      "v3 readiness",
      `${readiness.status || "UNKNOWN"} ${compact(readiness.gatesPassed || 0)}/${compact(readiness.gateCount || 0)}`,
    ],
    ["Supported findings", compact(finding.supported || 0)],
    ["Episode corpus", compact(finding.corpusEpisodeCount || 0)],
    ["Attributed episodes", compact(finding.attributedCorpusEpisodeCount || 0)],
    ["Independent UTC days", compact(finding.corpusUtcDayCount || 0)],
    [
      "Latest tested episodes",
      finding.latestEpisodeCount == null ? "NOT REPORTED" : compact(finding.latestEpisodeCount),
    ],
    ["Latest raw observations", compact(finding.latestObservationCount || 0)],
    ["Quality manifests", compact(report.qualityManifestCount)],
    ["Bounded attempts", `${compact(report.hypothesisAttemptCount)} / 72`],
    ["Rejected", compact(report.rejectionCount)],
    ["Promotions", compact(report.promotionCount)],
    ["Holdout", "SEALED"],
    ["Reaction features", compact(report.responseFailureCoverage.featureCount)],
    ["Complete reactions", compact(report.responseFailureCoverage.completeFeatureCount)],
  ]
    .map(
      ([label, value]) =>
        `<div class="health-item"><span class="label">${safe(label)}</span><strong>${safe(value)}</strong></div>`,
    )
    .join("");
  $("#phase-two-attempts").innerHTML =
    report.attempts
      .map(
        (attempt) =>
          `<div class="event"><span class="event-type">${safe(attempt.tier)}</span><div><strong>${safe(attempt.family.replaceAll("_", " "))}</strong><small>v${safe(attempt.familyVersion)} · ${safe(attempt.rejected ? "REJECTED" : attempt.status)}${attempt.promotionDecision ? ` · ${safe(attempt.promotionDecision)}` : ""}</small></div><time>${new Date(attempt.registeredAt).toLocaleDateString()}</time></div>`,
      )
      .join("") || `<p class="empty">No Phase 2 hypotheses registered.</p>`;
  const limitations = [
    `${compact(finding.notSupported || 0)} not supported`,
    `${compact(finding.insufficientData || 0)} insufficient data`,
    `${compact(finding.invalidatedDataQuality || 0)} invalidated by data quality`,
    finding.latestAttributionQuality
      ? `attribution ${finding.latestAttributionQuality}`
      : "attribution not reported",
  ].join(" · ");
  $("#phase-two-note").textContent = `${limitations}.${
    finding.latestHumanReviewAction ? ` Next review: ${finding.latestHumanReviewAction}` : ""
  } Readiness: ${(readiness.gates || [])
    .map(
      (gate) =>
        `${gate.gate} ${gate.unit === "PERCENT" ? Number(gate.current).toFixed(1) : compact(gate.current)}/${compact(gate.required)}${gate.unit === "PERCENT" ? "%" : ""} ${gate.passed ? "PASS" : "WAIT"}`,
    )
    .join(
      " · ",
    )}. Entity classes ${compact(readiness.verifiedEntityClassCount || 0)} · qualified directions ${compact(readiness.qualifiedDirectionCohortCount || 0)}.`;
}
function renderWalletCoverage(report) {
  const coverage = report.coverage;
  $("#wallet-coverage-status").innerHTML = [
    ["Wallets ≥30 events", compact(coverage.eligibleEntityCount)],
    ["Eligible wallet share", `${Number(coverage.eligibleEntityPct).toFixed(1)}%`],
    ["Eligible observations", compact(coverage.eligibleFeatureObservationCount)],
    ["Bidirectional wallets", compact(coverage.bidirectionalEligibleEntityCount)],
  ]
    .map(
      ([label, value]) =>
        `<div class="health-item"><span class="label">${safe(label)}</span><strong>${safe(value)}</strong></div>`,
    )
    .join("");
}
function renderEnrichment(report) {
  const readiness = report.readiness || {};
  $("#enrichment-status").innerHTML = [
    ["Capability probes", compact(report.capabilityManifestCount)],
    ["Usage records", compact(report.usageMetricCount)],
    ["Raw evidence", compact(report.rawObservationCount)],
    ["Canonical enrichment", compact(report.canonicalObservationCount)],
    ["Point-in-time eligible", compact(report.pointInTimeEligibleCount)],
    ["Nansen snapshots", compact(report.nansenSnapshotCount)],
    ["Change features", compact(report.nansenFeatureCount)],
    ["Credits today", `${compact(report.estimatedCreditsToday)} est.`],
    ["Collection gaps", compact(report.nansenGapCount)],
    ["Ablation manifests", compact(report.ablationManifestCount)],
    ["Ablation evaluations", compact(report.ablationEvaluationCount || 0)],
    [
      "Independent periods",
      `${compact(readiness.temporalClusterCount || 0)} / ${compact(readiness.minimumTemporalClusters || 30)}`,
    ],
    ["Research readiness", readiness.status || "ACCUMULATING"],
  ]
    .map(
      ([label, value]) =>
        `<div class="health-item"><span class="label">${safe(label)}</span><strong>${safe(value)}</strong></div>`,
    )
    .join("");
  const capabilityRows = report.latestCapabilities.map((item) => {
    const capabilities = Array.isArray(item.capabilities) ? item.capabilities : [];
    const summary = capabilities
      .map(
        (capability) =>
          `${capability.capability}: ${capability.available ? "AVAILABLE" : "RESTRICTED"}`,
      )
      .join(" · ");
    return `<div class="event"><span class="event-type">${safe(item.provider)}</span><div><strong>${safe(summary || "No capability details")}</strong><small>API ${safe(item.apiVersion)} · external enrichment only</small></div><time>${new Date(item.probedAt).toLocaleTimeString()}</time></div>`;
  });
  const featureRows = (report.latestNansenFeatures || [])
    .slice(0, 5)
    .map(
      (feature) =>
        `<div class="event"><span class="event-type">${safe(feature.symbol)}</span><div><strong>${safe(feature.holdingsValueDeltaUsd >= 0 ? "Accumulation" : "Distribution")} ${safe(Number(feature.holdingsValueDeltaPct ?? 0).toFixed(2))}%</strong><small>holders ${safe(feature.holdersCountDelta >= 0 ? "+" : "")}${safe(feature.holdersCountDelta)} · anomaly ${safe(feature.unusualChangeZScore === null ? "—" : Number(feature.unusualChangeZScore).toFixed(2))}σ · point-in-time</small></div><time>${new Date(feature.currentRetrievedAt).toLocaleTimeString()}</time></div>`,
    );
  const evaluation = report.latestAblationEvaluation;
  const evaluationRow = evaluation
    ? `<div class="event"><span class="event-type">EVAL</span><div><strong>${safe(evaluation.evaluation?.incrementalValue?.verdict || "Evaluation available")}</strong><small>${compact(evaluation.observationCount)} observations · ${compact(evaluation.evaluation?.incrementalValue?.uniqueEventTimeClusters || 0)} time clusters · Δ correlation ${safe(Number(evaluation.evaluation?.incrementalValue?.observedCorrelationDelta || 0).toFixed(4))} · p ${safe(Number(evaluation.evaluation?.incrementalValue?.permutationPValue || 0).toFixed(3))}</small></div><time>${new Date(evaluation.generatedAt).toLocaleTimeString()}</time></div>`
    : "";
  $("#enrichment-capabilities").innerHTML =
    [evaluationRow, ...capabilityRows, ...featureRows].join("") ||
    `<p class="empty">No enrichment probes recorded.</p>`;
}
function renderCfie(report) {
  const counts = report.counts;
  const cards = [
    ["Capital events", compact(counts.capitalEvents), `${counts.entities} observed entities`],
    ["Market events", compact(counts.marketEvents), `${counts.rawMarketMessages} raw messages`],
    [
      "Raw objects",
      compact(counts.rawObjects),
      `${counts.chainBlocks} blocks · ${counts.marketDataIncidents} feed incidents`,
    ],
    ["Evidence packets", compact(counts.evidencePackets), report.authority],
    [
      "Reference prices",
      compact(counts.referencePriceSnapshots),
      `${counts.capitalEventForwardOutcomes} outcomes · ${counts.marketReactionFeatures} reactions · ${counts.capitalEventBenchmarkOutcomes} BTC controls`,
    ],
    [
      "Verified attribution",
      `${Number(report.entityAttribution.coveragePct).toFixed(1)}%`,
      `${compact(report.entityAttribution.verifiedEndpointCount)} of ${compact(report.entityAttribution.endpointCount)} event endpoints`,
    ],
    [
      "Filtered stream",
      compact(counts.filteredTransactions),
      `${compact(report.filteredStream.finalized)} finalized · ${compact(report.filteredStream.normalized)} normalized · ${compact(report.filteredStream.linkedCapitalEvents)} capital events`,
    ],
    ["Research runs", compact(counts.researchAnalysisRuns), "Immutable preregistered analyses"],
  ];
  $("#cfie-metrics").innerHTML = cards
    .map(
      ([label, value, note]) =>
        `<article class="metric"><div class="label">${safe(label)}</div><div class="value">${safe(value)}</div><div class="note">${safe(note)}</div></article>`,
    )
    .join("");
  if (report.dashboardSampleEventLimit)
    $("#attribution-status").title =
      `Dashboard cohort summaries use the latest ${compact(report.dashboardSampleEventLimit)} capital events; immutable research runs remain full-protocol analyses.`;
  $("#capital-events").innerHTML =
    report.recentCapitalEvents
      .slice(0, 8)
      .map(
        (event) =>
          `<button class="event inspectable" data-event-id="${safe(event.eventId)}"><span class="event-type">${safe(event.eventType)}</span><div><strong>${safe(event.quantity)}</strong><small>${safe(event.fromLabel || "Unknown")} → ${safe(event.toLabel || "Unknown")}${event.venueLabel ? ` · via ${safe(event.venueLabel)}` : ""}</small></div><time>${new Date(event.eventTime).toLocaleTimeString()}</time></button>`,
      )
      .join("") || `<p class="empty">No normalized capital events recorded.</p>`;
  $("#capital-flow-episodes").innerHTML =
    report.recentCapitalFlowEpisodes
      .map(
        (episode) =>
          `<div class="event"><span class="event-type">EPISODE</span><div><strong>${compact(episode.totalQuantity)} SOL</strong><small>${compact(episode.eventCount)} transfers grouped · direction ${safe(episode.dominantCohort)}${episode.primaryVenueLabel ? ` · context ${safe(episode.primaryVenueLabel)} (${compact(episode.verifiedVenueEventCount)} verified transfers)` : " · no verified protocol context"}</small></div><time>${new Date(episode.windowStart).toLocaleTimeString()}</time></div>`,
      )
      .join("") || `<p class="empty">No independent capital-flow episode has finalized yet.</p>`;
  $("#market-events").innerHTML =
    report.recentMarketEvents
      .slice(0, 8)
      .map(
        (event) =>
          `<div class="event"><span class="event-type ${event.side === "BUY" ? "buy" : "sell"}">${safe(event.side || event.eventType)}</span><div><strong>${event.price ? money(event.price, 2) : "—"}</strong><small>${safe(event.quantity || "No quantity")}</small></div><time>${new Date(event.eventTime).toLocaleTimeString()}</time></div>`,
      )
      .join("") || `<p class="empty">No market events recorded.</p>`;
  const timeline = [
    ...report.recentCapitalEvents.map((event) => ({
      at: event.eventTime,
      kind: "CHAIN",
      title: event.eventType,
      detail: event.quantity,
    })),
    ...report.recentMarketEvents.map((event) => ({
      at: event.eventTime,
      kind: "MARKET",
      title: event.side || event.eventType,
      detail: event.price ? money(event.price, 2) : "—",
    })),
  ]
    .sort((left, right) => left.at.localeCompare(right.at))
    .slice(-10);
  $("#unified-timeline").innerHTML = timeline
    .map(
      (event) =>
        `<div class="event"><span class="event-type">${safe(event.kind)}</span><div><strong>${safe(event.title)}</strong><small>${safe(event.detail)}</small></div><time>${new Date(event.at).toLocaleTimeString()}</time></div>`,
    )
    .join("");
  $("#evidence-packets").innerHTML =
    report.recentEvidencePackets
      .map(
        (packet) =>
          `<div class="event"><span class="event-type">${safe(packet.action)}</span><div><strong>${safe(packet.dataQuality)}</strong><small>${Math.round(packet.confidence * 100)}% confidence · ${packet.contradictionCount} contradiction${packet.contradictionCount === 1 ? "" : "s"}</small></div><time>${new Date(packet.generatedAt).toLocaleTimeString()}</time></div>`,
      )
      .join("") || `<p class="empty">No evidence packets generated.</p>`;
  $("#reference-prices").innerHTML =
    report.recentReferencePrices
      .slice(0, 8)
      .map(
        (estimate) =>
          `<div class="event"><span class="event-type ${estimate.status === "PUBLISHED" ? "buy" : "sell"}">${safe(estimate.status)}</span><div><strong>${estimate.price ? money(estimate.price, 6) : "WITHHELD"}</strong><small>${Math.round(Number(estimate.qualityScore) * 100)}% quality · ${estimate.venueEstimates.length} venues${estimate.uncertaintyBps ? ` · ±${safe(estimate.uncertaintyBps)} bps` : ""}</small></div><time>${new Date(estimate.asOf).toLocaleTimeString()}</time></div>`,
      )
      .join("") || `<p class="empty">No reference estimates computed.</p>`;
  const queue = report.normalizationQueue;
  const health = report.operationalHealth;
  const age = (seconds) => (seconds === undefined ? "no data" : `${Math.round(seconds)}s old`);
  const reasons = health.reasons.length
    ? `<small>${health.reasons.map(safe).join(" · ")}</small>`
    : `<small>All configured thresholds pass.</small>`;
  $("#queue-health").innerHTML =
    `<span>Operational health<br>${reasons}</span><strong class="${health.status === "HEALTHY" ? "positive" : "negative"}">${safe(health.status)}</strong><strong>Chain ${age(health.chainAgeSeconds)}</strong><strong>Market ${age(health.marketAgeSeconds)}</strong><strong>${queue.pending} normalization pending</strong><strong>${report.filteredStream.pending} reconciliation pending</strong><strong class="${queue.failed || report.filteredStream.failed ? "negative" : "positive"}">${queue.failed + report.filteredStream.failed} failed</strong>`;
  $("#attribution-status").innerHTML = [
    ["Verified addresses", counts.verifiedEntityAddresses],
    ["Verified endpoints", report.entityAttribution.verifiedEndpointCount],
    [
      "Unknown endpoints",
      report.entityAttribution.endpointCount - report.entityAttribution.verifiedEndpointCount,
    ],
    ["Coverage", `${Number(report.entityAttribution.coveragePct).toFixed(2)}%`],
    ["Evidence sources", report.entityRegistryQuality.sourceCount],
    ["Single-source labels", report.entityRegistryQuality.singleSourceAddressCount],
    ["Conflicting labels", report.entityRegistryQuality.conflictingAddressCount],
  ]
    .map(
      ([label, value]) =>
        `<div class="health-item"><span class="label">${safe(label)}</span><strong>${safe(value)}</strong></div>`,
    )
    .join("");
  $("#research-runs").innerHTML =
    report.recentResearchRuns
      .map((run) => {
        const verdict = run.validationVerdict || run.status;
        const positive = verdict === "HOLDOUT_REPLICATED";
        const note =
          verdict === "HOLDOUT_UNDERPOWERED"
            ? `${run.significantCellCount} development findings · holdout too small`
            : verdict === "FAILED_HOLDOUT"
              ? `${run.eligibleHoldoutCount} eligible holdouts · none replicated`
              : verdict === "HOLDOUT_REPLICATED"
                ? `${run.replicatedHoldoutCount} holdout replication${run.replicatedHoldoutCount === 1 ? "" : "s"} · further falsification required`
                : verdict === "NO_DEVELOPMENT_FINDING"
                  ? "No development-set finding survived correction"
                  : verdict === "PARTIAL_NO_DEVELOPMENT_FINDING"
                    ? "Tested mature cells showed no effect · other horizons still immature"
                    : "Insufficient data for a statistical conclusion";
        const controls = run.falsificationControls?.length
          ? run.falsificationControls
          : run.falsificationControl
            ? [
                {
                  control: run.falsificationControl,
                  testedCount: run.falsificationTestedCount,
                  survivingCount: run.falsificationSurvivingCount,
                },
              ]
            : [];
        const falsification = controls
          .map(
            (control) =>
              ` · ${control.survivingCount}/${control.testedCount} survived ${control.control.replaceAll("_", " ").toLowerCase()}${control.trialCount ? ` (${control.trialCount} trials)` : ""}`,
          )
          .join("");
        return `<div class="event"><span class="event-type ${positive ? "buy" : "sell"}">${safe(verdict.replaceAll("_", " "))}</span><div><strong>${safe(run.analysisFamily.replaceAll("_", " "))}</strong><small>${compact(run.observationCount)} observations · ${safe(note + falsification)}</small></div><time>${new Date(run.generatedAt).toLocaleDateString()}</time></div>`;
      })
      .join("") || `<p class="empty">No preregistered analysis run has completed.</p>`;
  $("#directional-outcomes").innerHTML =
    [
      ...report.protocolInteractionOutcomes.map((cohort) => ({
        horizon: cohort.horizon,
        title: `Via ${cohort.venueLabel}`,
        sampleSize: cohort.sampleSize,
        meanReturnPct: cohort.meanReturnPct,
      })),
      ...report.directionalOutcomes.map((cohort) => ({
        horizon: cohort.horizon,
        title: `${cohort.fromClass} → ${cohort.toClass}`,
        sampleSize: cohort.sampleSize,
        meanReturnPct: cohort.meanReturnPct,
      })),
    ]
      .slice(0, 10)
      .map(
        (cohort) =>
          `<div class="event"><span class="event-type">${safe(cohort.horizon)}</span><div><strong>${safe(cohort.title)}</strong><small>${compact(cohort.sampleSize)} observations · mean ${pct(cohort.meanReturnPct)}</small></div></div>`,
      )
      .join("") || `<p class="empty">No matured directional cohorts yet.</p>`;
}
function renderFilteredAlerts(report) {
  if (report) state.filteredAlerts = report.alerts || [];
  const directionFilter = $("#alert-direction-filter").value;
  const anomalyFilter = $("#alert-anomaly-filter").value;
  const sort = $("#alert-sort").value;
  const alerts = state.filteredAlerts
    .filter(
      (alert) =>
        directionFilter === "ALL" ||
        alert.capitalEvents.some((event) => event.intelligence?.direction === directionFilter),
    )
    .filter((alert) => {
      if (anomalyFilter === "ALL") return true;
      if (anomalyFilter === "ANOMALOUS") return (alert.summary?.anomalousTransferCount || 0) > 0;
      return alert.capitalEvents.some(
        (event) => event.intelligence?.walletAnomaly !== "INSUFFICIENT_HISTORY",
      );
    })
    .sort((left, right) => {
      if (sort === "NEWEST") return Date.parse(right.receivedAt) - Date.parse(left.receivedAt);
      if (sort === "OUTCOME")
        return (
          (right.summary?.matureOutcomeCount || 0) +
          (right.summary?.marketReactionCount || 0) -
          ((left.summary?.matureOutcomeCount || 0) + (left.summary?.marketReactionCount || 0))
        );
      return (right.summary?.maxQualityScore || 0) - (left.summary?.maxQualityScore || 0);
    });
  $("#alert-result-count").textContent =
    `${alerts.length} of ${state.filteredAlerts.length} alerts shown`;
  $("#filtered-alerts").innerHTML =
    alerts
      .map((alert) => {
        const status = alert.normalizedAt ? "NORMALIZED" : alert.reconciliationStatus;
        const eventSummary = alert.capitalEvents.length
          ? alert.capitalEvents
              .slice(0, 3)
              .map((event) => {
                const direction = `${event.fromLabel || event.fromEntityType || "Unknown"} → ${event.toLabel || event.toEntityType || "Unknown"}`;
                const outcomes = event.outcomes.length
                  ? event.outcomes
                      .map(
                        (outcome) =>
                          `${outcome.horizon} ${Number(outcome.returnPct) >= 0 ? "+" : ""}${Number(outcome.returnPct).toFixed(3)}%`,
                      )
                      .join(" · ")
                  : "outcomes maturing";
                const intelligence = event.intelligence || {};
                const anomaly = intelligence.walletAnomaly || "INSUFFICIENT_HISTORY";
                const zScore = Number.isFinite(event.walletHistory?.quantityZScore)
                  ? ` · size Z ${Number(event.walletHistory.quantityZScore).toFixed(2)}`
                  : "";
                const dormant = Number.isFinite(event.walletHistory?.dormantDays)
                  ? ` · dormant ${Number(event.walletHistory.dormantDays).toFixed(1)}d`
                  : "";
                const reaction = event.marketReactions?.[0];
                const reactionSummary = reaction
                  ? `<small class="market-reaction">${Math.round(reaction.windowSeconds / 60)}m market: imbalance ${safe(reaction.features.aggressorImbalance ?? "—")} · price ${pct(reaction.features.midPriceReturnPct)} · depth ${pct(reaction.features.totalDepthChangePct)} · absorption ${safe(reaction.features.absorptionScore ?? "—")}</small>`
                  : `<small>Market reaction is not available yet.</small>`;
                return `<button class="alert-event inspectable" data-event-id="${safe(event.eventId)}"><strong><span class="quality-score">${safe(intelligence.qualityScore ?? 0)}</span> ${safe(event.quantity)} · ${safe(direction)}</strong><small>${safe(intelligence.direction || "UNCLASSIFIED_TRANSFER")} · ${safe(intelligence.protocolAction || "NONE")} · wallet ${safe(anomaly)}${safe(zScore)}${safe(dormant)}</small><small>${safe(event.venueLabel || "Direct transfer")} · ${safe(outcomes)}</small>${reactionSummary}</button>`;
              })
              .join("")
          : `<small>No recognized transfer instruction linked yet.</small>`;
        const summary = alert.summary || {};
        return `<article class="filtered-alert"><div class="alert-heading"><span class="event-type">${safe(status)}</span><strong>${safe(summary.primaryDirection || "NO_TRANSFER")}</strong><time>${new Date(alert.receivedAt).toLocaleTimeString()}</time></div><small class="signature">${safe(alert.signature.slice(0, 18))}…${safe(alert.signature.slice(-10))} · slot ${safe(alert.slot)}</small><div class="alert-summary"><span>${safe(summary.transferCount || 0)} transfers</span><span>${safe(summary.assetCount || 0)} assets</span><span>${safe(summary.anomalousTransferCount || 0)} unusual</span><span>${safe(summary.matureOutcomeCount || 0)} outcomes</span><span>${safe(summary.marketReactionCount || 0)} reactions</span></div><div class="alert-events">${eventSummary}</div></article>`;
      })
      .join("") || `<p class="empty">No Helius filtered alerts recorded yet.</p>`;
}
function exportFilteredAlerts() {
  const rows = state.filteredAlerts.map((alert) => ({
    received_at: alert.receivedAt,
    signature: alert.signature,
    status: alert.normalizedAt ? "NORMALIZED" : alert.reconciliationStatus,
    primary_direction: alert.summary?.primaryDirection || "NO_TRANSFER",
    protocol_action: alert.summary?.primaryProtocolAction || "NONE",
    quality_score: alert.summary?.maxQualityScore || 0,
    transfers: alert.summary?.transferCount || 0,
    assets: alert.summary?.assetCount || 0,
    unusual_transfers: alert.summary?.anomalousTransferCount || 0,
    outcomes: alert.summary?.matureOutcomeCount || 0,
    market_reactions: alert.summary?.marketReactionCount || 0,
  }));
  const fields = Object.keys(rows[0] || { received_at: "", signature: "" });
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [
    fields.join(","),
    ...rows.map((row) => fields.map((field) => quote(row[field])).join(",")),
  ].join("\n");
  const url = URL.createObjectURL(new globalThis.Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `cfie-helius-alerts-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
async function inspectCapitalEvent(eventId) {
  const dialog = $("#event-dialog");
  $("#event-dialog-title").textContent = eventId;
  $("#event-dialog-content").innerHTML = `<p class="empty">Loading evidence…</p>`;
  dialog.showModal();
  try {
    const response = await fetch(`/api/capital-event?id=${encodeURIComponent(eventId)}`, {
      cache: "no-store",
    });
    const detail = await response.json();
    if (!response.ok) throw new Error(detail.error || "Unable to inspect event");
    const entityCard = (title, entity) =>
      `<div class="detail-card"><span class="label">${safe(title)}</span><strong>${safe(entity?.label || "Unknown")}</strong><small>${safe(entity?.entityType || "Unattributed")}${entity?.attributionSource ? ` · ${safe(entity.attributionSource)}` : ""}</small><code>${safe(entity?.addresses?.join(" · ") || entity?.entityId || "No endpoint")}</code></div>`;
    const outcomes = detail.outcomes.length
      ? `<table class="detail-table"><thead><tr><th>Horizon</th><th>Return</th><th>Best</th><th>Worst</th></tr></thead><tbody>${detail.outcomes.map((item) => `<tr><td>${safe(item.horizon)}</td><td class="${Number(item.returnPct) >= 0 ? "positive" : "negative"}">${pct(item.returnPct)}</td><td>${pct(item.maximumFavorableExcursionPct)}</td><td>${pct(item.maximumAdverseExcursionPct)}</td></tr>`).join("")}</tbody></table>`
      : `<p class="empty">No forward outcome has matured yet.</p>`;
    const reactions = detail.marketReactions.length
      ? detail.marketReactions
          .map(
            (item) =>
              `<div class="event"><span class="event-type">${Math.round(item.windowSeconds / 60)}m</span><div><strong>${safe(item.venue)}</strong><small>imbalance ${safe(item.features.aggressorImbalance ?? "—")} · spread ${safe(item.features.spreadBpsAfter ?? "—")} bps · depth ${pct(item.features.totalDepthChangePct)}</small></div></div>`,
          )
          .join("")
      : `<p class="empty">No synchronized market-reaction window has matured yet.</p>`;
    $("#event-dialog-title").textContent = `${detail.event.eventType} · ${detail.event.quantity}`;
    $("#event-dialog-content").innerHTML = `<div class="detail-grid">
      <div class="detail-card wide"><span class="label">Observed</span><strong>${new Date(detail.event.eventTime).toLocaleString()}</strong><small>${safe(detail.event.chain)} · confidence ${Math.round(detail.event.confidence * 100)}%</small><code>${safe(detail.event.transactionHash || "No transaction hash")}</code></div>
      ${entityCard("From", detail.fromEntity)}${entityCard("To", detail.toEntity)}
      <div class="detail-card wide"><span class="label">Invoking protocol</span><strong>${safe(detail.protocol?.label || "Not attributed")}</strong><small>${safe(detail.protocol?.entityType || "No verified program context")}</small><code>${safe(detail.protocol?.address || detail.event.venue || "None")}</code></div>
      <div class="detail-card wide"><span class="label">Forward outcomes</span>${outcomes}</div>
      <div class="detail-card wide"><span class="label">Market reaction</span>${reactions}</div>
      <div class="detail-card wide"><span class="label">Raw evidence reference</span><code>${safe(detail.event.rawRef)}</code></div>
    </div>`;
  } catch (error) {
    $("#event-dialog-content").innerHTML =
      `<div class="error">${safe(error instanceof Error ? error.message : "Unable to inspect event")}</div>`;
  }
}
function renderEntityCandidates(report) {
  const rows = report.candidates || [];
  $("#entity-candidate-rows").innerHTML =
    rows
      .map(
        (candidate) => `<tr>
          <td>${safe(candidate.rank)}</td>
          <td><code class="address-code" title="${safe(candidate.address || candidate.entityId)}">${safe(candidate.address || candidate.entityId)}</code></td>
          <td>${safe(candidate.behaviorHeuristic.replace("HEURISTIC_", "").replaceAll("_", " "))}</td>
          <td>${compact(candidate.eventCount)}</td>
          <td>${compact(candidate.uniqueCounterpartyCount)}</td>
          <td><span class="event-type ${candidate.identityStatus === "VERIFIED" ? "buy" : "sell"}">${safe(candidate.identityStatus)}</span></td>
          <td><span class="event-type">${safe(candidate.reviewStatus)}</span></td>
        </tr>`,
      )
      .join("") ||
    `<tr><td colspan="7" class="empty">No endpoints meet the current activity threshold.</td></tr>`;
  $("#entity-candidate-note").textContent =
    `${report.warning} Generated ${new Date(report.generatedAt).toLocaleString()}${report.cached ? " · cached for dashboard performance" : ""}.`;
  const quality = report.quality;
  if (quality) {
    $("#owner-correction-status").innerHTML = [
      ["Owner extraction", `${Number(quality.extractionCoveragePct).toFixed(1)}%`],
      ["Corrected endpoints", compact(quality.correctedEndpointCount)],
      ["Token accounts", compact(quality.distinctTokenAccountCount)],
      ["Economic owners", compact(quality.distinctOwnerCount)],
      ["Rollup endpoints", compact(quality.rolledUpEndpointCount)],
      ["Verified coverage", `${Number(quality.verifiedEndpointCoveragePct).toFixed(3)}%`],
    ]
      .map(
        ([label, value]) =>
          `<div class="health-item"><span class="label">${safe(label)}</span><strong>${safe(value)}</strong></div>`,
      )
      .join("");
  }
  const flow = report.protocolFlow;
  if (flow) {
    $("#protocol-flow-status").innerHTML = [
      ["Five-minute windows", compact(flow.windowCount)],
      ["Fee-flow events", compact(flow.totalEventCount)],
      ["Baseline-ready windows", compact(flow.baselineReadyWindowCount)],
      ["Outcome-ready windows", compact(flow.matureWindowCount)],
      ["BTC-controlled outcomes", compact(flow.benchmarkOutcomeCount)],
      ["Analysis-ready windows", compact(flow.analysisReadyWindowCount)],
      ["Latest events", compact(flow.latestEventCount || 0)],
      ["Latest counterparties", compact(flow.latestDistinctCounterpartyCount || 0)],
      ["Burst z-score", flow.latestEventCountZScore || "Awaiting baseline"],
    ]
      .map(
        ([label, value]) =>
          `<div class="health-item"><span class="label">${safe(label)}</span><strong>${safe(value)}</strong></div>`,
      )
      .join("");
  }
  const protocol = report.protocolResearch;
  if (protocol) {
    $("#protocol-research-status").innerHTML = [
      ["Protocol", protocol.registered ? "Frozen" : "Not registered"],
      ["Minimum sample", compact(protocol.minimumSampleSize || 0)],
      ["Development observations", compact(protocol.latestObservationCount)],
      ["Timestamp trials", compact(protocol.randomizedTimestampTrials)],
      ["Holdout", protocol.holdoutSealed ? "SEALED" : "ACCESSED"],
      [
        "Dataset cutoff",
        protocol.datasetCutoff ? new Date(protocol.datasetCutoff).toLocaleDateString() : "—",
      ],
    ]
      .map(
        ([label, value]) =>
          `<div class="health-item"><span class="label">${safe(label)}</span><strong>${safe(value)}</strong></div>`,
      )
      .join("");
  }
}
async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  const button = $("#refresh");
  button.disabled = true;
  button.textContent = "Refreshing…";
  try {
    const load = async (url, renderValue, label) => {
      const response = await fetch(url, { cache: "no-store" });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `${label} request failed`);
      renderValue(value);
    };
    const results = await Promise.allSettled([
      load("/api/report", render, "Dashboard"),
      load(
        "/api/cfie",
        (value) => {
          renderProgress(value);
          renderCfie(value);
        },
        "CFIE summary",
      ),
      load("/api/entity-candidates", renderEntityCandidates, "Entity candidates"),
      load("/api/operations", renderOperations, "Operations"),
      load("/api/phase-two", renderPhaseTwo, "Phase 2"),
      load("/api/wallet-coverage", renderWalletCoverage, "Wallet coverage"),
      load("/api/enrichment", renderEnrichment, "Enrichment"),
      load("/api/paper-lab", renderPaperLab, "Paper laboratory"),
      load("/api/trading-bots", renderTradingBots, "Trading bots"),
      load("/api/filtered-alerts?limit=20", renderFilteredAlerts, "Filtered alerts"),
    ]);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length === 0) {
      $("#error").hidden = true;
    } else {
      $("#error").textContent = failures
        .map((failure) =>
          failure.reason instanceof Error ? failure.reason.message : "Dashboard section failed",
        )
        .join(" · ");
      $("#error").hidden = false;
    }
  } catch (error) {
    $("#error").textContent =
      error instanceof Error ? error.message : "Unable to refresh dashboard";
    $("#error").hidden = false;
  } finally {
    state.refreshing = false;
    button.disabled = false;
    button.textContent = "Refresh data";
  }
}
document.querySelectorAll(".filter").forEach((button) =>
  button.addEventListener("click", () => {
    document.querySelectorAll(".filter").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.filter = button.dataset.filter;
    if (state.report) renderCandidates(state.report);
  }),
);
$("#refresh").addEventListener("click", refresh);
$("#capital-events").addEventListener("click", (event) => {
  const target = event.target.closest("[data-event-id]");
  if (target?.dataset.eventId) void inspectCapitalEvent(target.dataset.eventId);
});
$("#filtered-alerts").addEventListener("click", (event) => {
  const target = event.target.closest("[data-event-id]");
  if (target?.dataset.eventId) void inspectCapitalEvent(target.dataset.eventId);
});
["#alert-direction-filter", "#alert-anomaly-filter", "#alert-sort"].forEach((selector) =>
  $(selector).addEventListener("change", () => renderFilteredAlerts()),
);
$("#alert-export").addEventListener("click", exportFilteredAlerts);
$("#event-dialog-close").addEventListener("click", () => $("#event-dialog").close());
refresh();
setInterval(refresh, 30_000);
