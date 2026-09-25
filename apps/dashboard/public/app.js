const state = { report: null, filter: "all" };
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
async function refresh() {
  const button = $("#refresh");
  button.disabled = true;
  button.textContent = "Refreshing…";
  try {
    const response = await fetch("/api/report", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Dashboard request failed");
    $("#error").hidden = true;
    render(result);
  } catch (error) {
    $("#error").textContent =
      error instanceof Error ? error.message : "Unable to refresh dashboard";
    $("#error").hidden = false;
  } finally {
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
refresh();
setInterval(refresh, 15000);
