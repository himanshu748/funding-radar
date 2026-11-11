(() => {
  "use strict";

  const caseList = document.querySelector("#case-list");
  const content = document.querySelector("#case-content");
  const detailDialog = document.querySelector("#detail-dialog");
  const detailContent = document.querySelector("#dialog-content");
  const briefDialog = document.querySelector("#brief-dialog");
  const briefForm = document.querySelector("#brief-form");
  const descriptionInput = document.querySelector("#description");
  const planResult = document.querySelector("#plan-result");
  const prepareButton = document.querySelector("#prepare-plan");
  const liveControls = document.querySelector("#live-controls");
  const liveStatus = document.querySelector("#live-status");
  const liveButton = document.querySelector("#start-research");
  const cancelButton = document.querySelector("#cancel-research");
  const checkButton = document.querySelector("#check-research");
  const tabs = ["companies", "investors", "notes"];
  const tabLabels = {
    companies: "Companies",
    investors: "Investor candidates",
    notes: "Review notes",
  };
  const decisions = {
    verified_recent: { text: "Reviewed recent", className: "good" },
    out_of_window: { text: "Outside window", className: "warn" },
    not_comparable: { text: "Not comparable", className: "warn" },
    unresolved: { text: "Unresolved", className: "pending" },
    not_reviewed: { text: "Not reviewed", className: "pending" },
  };
  const state = {
    cases: [],
    selected: null,
    data: null,
    tab: "companies",
    query: "",
    status: "all",
    freshResearchEnabled: false,
    liveLimits: null,
    liveJob: null,
  };
  let caseController;
  let loadVersion = 0;
  let detailOpener;
  let briefOpener;
  let planUrl;
  let toastTimer;
  let pollTimer;
  let jobController;

  const array = (value) => (Array.isArray(value) ? value : []);
  const string = (value, fallback = "Not established") =>
    typeof value === "string" && value.trim() ? value : fallback;
  const escape = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character],
    );
  const number = (value) =>
    Number.isInteger(value) && value >= 0 ? String(value) : "Unknown";
  const normalize = (value) =>
    String(value ?? "")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const isSavedCase = (id) => [1, 2, 3].includes(id);
  const isResearchId = (id) =>
    typeof id === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
  const casePath = (id) =>
    isSavedCase(id)
      ? `/api/case/${id}`
      : isResearchId(id)
        ? `/api/investigation/${id}`
        : null;
  const isRecordedCase = (entry) =>
    isSavedCase(entry?.id) || entry?.result_origin === "recorded_live";
  const caseLabel = (entry) =>
    isSavedCase(entry.id)
      ? `INVESTIGATION 0${entry.id}`
      : isRecordedCase(entry)
        ? "RECORDED INVESTIGATION"
        : "NEW INVESTIGATION";
  const configuredLiveLimits = () => {
    const limits = state.liveLimits;
    return limits &&
      Number.isInteger(limits.target_rows) &&
      limits.target_rows > 0 &&
      Number.isFinite(limits.maximum_estimated_cost_usd) &&
      limits.maximum_estimated_cost_usd >= 0 &&
      typeof limits.price_note === "string" &&
      limits.price_note.trim()
      ? limits
      : null;
  };

  function exportBase(data) {
    const fallback = casePath(data.id);
    return data.export_base === fallback ? data.export_base : fallback;
  }

  function money(value, currency) {
    if (!Number.isFinite(value) || value < 0) return "Not established";
    try {
      return new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency,
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(value);
    } catch {
      return `${value.toLocaleString("en-GB")} ${string(currency, "")}`.trim();
    }
  }

  function chequeSummary(cheque) {
    if (Number.isFinite(cheque?.minimum) && Number.isFinite(cheque?.maximum))
      return `${money(cheque.minimum, cheque.currency)} to ${money(cheque.maximum, cheque.currency)}`;
    if (typeof cheque?.summary === "string" && cheque.summary.trim())
      return cheque.summary;
    return "Typical cheque not established";
  }

  function supportingLinks(urls) {
    return [...new Set(array(urls))]
      .map((url) => `<p>${sourceLink(url, "Supporting source")}</p>`)
      .join("");
  }

  function httpsUrl(value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      const hostname = url.hostname.toLowerCase();
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !hostname.includes(".") ||
        /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) ||
        hostname.endsWith(".localhost") ||
        hostname.endsWith(".local") ||
        hostname.includes(":")
      )
        return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function sourceLink(value, label = "Open source") {
    const url = httpsUrl(value);
    return url
      ? `<a class="source-link" href="${escape(url)}" rel="noreferrer noopener">${escape(label)} <span aria-hidden="true">↗</span></a>`
      : `<span>${escape(label === "Open source" ? "No valid public HTTPS source" : label)}</span>`;
  }

  function period(day, month) {
    if (typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
      const date = new Date(day + "T00:00:00Z");
      if (
        Number.isFinite(date.valueOf()) &&
        date.toISOString().slice(0, 10) === day
      )
        return new Intl.DateTimeFormat("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        }).format(date);
    }
    if (typeof month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return (
        new Intl.DateTimeFormat("en-GB", {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(month + "-01T00:00:00Z")) + " (month only)"
      );
    }
    return "Not established";
  }

  function timestamp(value) {
    if (typeof value !== "string") return "Not available";
    const date = new Date(value);
    return Number.isFinite(date.valueOf())
      ? new Intl.DateTimeFormat("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "UTC",
        }).format(date) + " UTC"
      : "Not available";
  }

  function badge(status) {
    const item = decisions[status] ?? decisions.not_reviewed;
    return `<span class="tag ${item.className}">${item.text}</span>`;
  }

  const isPublicAddition = (row) =>
    row?.record_origin === "ordinary_web_supplement";

  function investorReviews() {
    const data = state.data;
    if (!data) return [];
    return [
      ...array(data.review?.investors).map((investor) => ({
        investor,
        origin: "Separate source review",
        checkedAt: data.review.updated_at ?? data.review.checked_at,
      })),
      ...array(data.public_source_supplement?.investor_reviews).map(
        (investor) => ({
          investor,
          origin: "Public-source supplement",
          checkedAt: data.public_source_supplement.checked_at,
        }),
      ),
    ];
  }

  function list(items, className = "review-list") {
    return `<ul class="${className}">${array(items)
      .map((item) => `<li>${escape(item)}</li>`)
      .join("")}</ul>`;
  }

  function facts(items) {
    return `<dl class="facts">${items.map(([label, value]) => `<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`).join("")}</dl>`;
  }

  function toast(message) {
    const element = document.querySelector("#toast");
    clearTimeout(toastTimer);
    element.textContent = message;
    element.classList.add("show");
    toastTimer = setTimeout(() => element.classList.remove("show"), 4500);
  }

  async function requestJson(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      cache: "no-store",
      headers: { Accept: "application/json", ...options.headers },
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(
        "The response could not be read. No automatic retry was made.",
      );
    }
    if (!response.ok)
      throw Object.assign(
        new Error(
          typeof data?.error === "string"
            ? data.error
            : string(
                data?.error?.message,
                "The request could not be completed. No automatic retry was made.",
              ),
        ),
        { code: data?.error?.code ?? data?.code, status: response.status },
      );
    return data;
  }

  function renderCaseList() {
    caseList.setAttribute("role", "group");
    caseList.innerHTML = state.cases
      .map(
        (entry) =>
          `<button class="case-button" type="button" data-case="${escape(entry.id)}" aria-pressed="${state.selected === entry.id}"><span class="case-number" aria-hidden="true">${isSavedCase(entry.id) ? `0${entry.id}` : isRecordedCase(entry) ? "SAVED" : "NEW"}</span><strong>${escape(entry.label)}</strong><span class="case-geo">${escape(period(entry.collected_at?.slice(0, 10) ?? entry.window?.as_of))} · ${isRecordedCase(entry) ? "recorded brief" : "new investigation"}</span><span class="case-state">${number(entry.coverage?.independently_reviewed_recent)} / ${number(entry.coverage?.required)} reviewed recent</span></button>`,
      )
      .join("");
    const count = document.querySelector(".number-tag");
    if (count) count.textContent = String(state.cases.length).padStart(2, "0");
  }

  async function loadCases() {
    state.freshResearchEnabled = false;
    state.liveLimits = null;
    updateLiveControls();
    caseList.innerHTML =
      '<p class="loading" role="status">Loading saved research…</p>';
    content.setAttribute("aria-busy", "true");
    try {
      const payload = await requestJson("/api/cases");
      if (!Array.isArray(payload?.cases))
        throw new Error(
          "The saved investigations are not available in the expected format.",
        );
      state.freshResearchEnabled = payload.fresh_research_enabled === true;
      state.liveLimits = payload.live_limits ?? null;
      updateLiveControls();
      const newInvestigations = state.cases.filter((entry) =>
        isResearchId(entry.id),
      );
      const cases = new Map();
      for (const entry of [
        ...payload.cases.filter((entry) => entry && casePath(entry.id)),
        ...newInvestigations,
      ]) {
        cases.set(entry.id, { ...entry, ...cases.get(entry.id) });
      }
      state.cases = [...cases.values()];
      if (!state.cases.length) {
        caseList.innerHTML =
          '<p class="empty-state">No saved investigations are available.</p>';
        content.innerHTML =
          '<div class="empty-state"><h3>No recorded research yet.</h3><p>You can still prepare a local brief. No live research will start.</p><button class="button primary" type="button" data-open-brief>Prepare a brief</button></div>';
        return;
      }
      state.selected = state.cases.some((entry) => entry.id === state.selected)
        ? state.selected
        : state.cases[0].id;
      renderCaseList();
      await loadCase(state.selected);
    } catch (error) {
      caseList.innerHTML =
        '<p class="error-message">Saved briefs unavailable.</p><button class="new-brief" type="button" data-retry-cases>Retry saved briefs</button>';
      content.innerHTML = `<div class="empty-state" role="alert"><h3>We could not load the saved research.</h3><p>${escape(error.message)}</p><p>No live research was started.</p><button class="button primary" type="button" data-retry-cases>Try again</button></div>`;
    } finally {
      content.setAttribute("aria-busy", "false");
    }
  }

  async function loadCase(id) {
    const path = casePath(id);
    if (!path) return;
    const version = ++loadVersion;
    caseController?.abort();
    caseController = new AbortController();
    state.selected = id;
    state.data = null;
    state.query = "";
    state.status = "all";
    state.tab = "companies";
    renderCaseList();
    content.setAttribute("aria-busy", "true");
    content.innerHTML =
      '<p class="loading" role="status">Opening the investigation…</p>';
    try {
      const data = await requestJson(path, {
        signal: caseController.signal,
      });
      if (version !== loadVersion) return;
      if (
        !data ||
        data.id !== id ||
        !Array.isArray(data.rows) ||
        !Array.isArray(data.investor_candidates) ||
        !data.coverage ||
        !data.original ||
        !data.window
      )
        throw new Error("This investigation has an unsupported format.");
      const index = state.cases.findIndex((entry) => entry.id === id);
      const previous = state.cases[index];
      const entry = {
        ...previous,
        id,
        label: string(
          data.label,
          previous?.label ??
            (isRecordedCase({ ...data, id })
              ? "Recorded investigation"
              : "New investigation"),
        ),
        result_origin: data.result_origin ?? previous?.result_origin,
        collected_at:
          data.collected_at ??
          data.original.collected_at ??
          previous?.collected_at,
        recording: data.recording ?? previous?.recording,
        window: data.window,
        coverage: data.coverage,
      };
      state.data = {
        ...data,
        label: entry.label,
        result_origin: entry.result_origin,
        collected_at: entry.collected_at,
        recording: entry.recording,
      };
      if (index < 0) state.cases.push(entry);
      else state.cases[index] = entry;
      renderCaseList();
      renderWorkspace();
      return true;
    } catch (error) {
      if (error.name === "AbortError" || version !== loadVersion) return;
      content.innerHTML = `<div class="empty-state" role="alert"><h3>This investigation could not be opened.</h3><p>${escape(error.message)}</p><p>The original research is unchanged. No provider operation was started.</p><button class="button primary" type="button" data-retry-case>Retry this investigation</button></div>`;
      return false;
    } finally {
      if (version === loadVersion) content.setAttribute("aria-busy", "false");
    }
  }

  function renderWorkspace() {
    const data = state.data;
    const coverage = data.coverage;
    const supplement = data.public_source_supplement;
    const publicCount = coverage.ordinary_web_supplement_companies ?? 0;
    const exports = exportBase(data);
    const companyReviewOnly =
      data.result_origin === "recorded_live" &&
      !array(data.reviewed_shortlist?.investors).length;
    content.innerHTML = `<div class="case-heading"><div><span class="small-label">${escape(caseLabel(data))}</span><h3>${escape(data.label)}</h3></div><span class="mode-badge">${isRecordedCase(data) ? "RECORDED RESEARCH" : "NEW INVESTIGATION"}</span></div><p class="description">${escape(data.description)}</p><p class="case-meta">${isRecordedCase(data) ? "Historical funding window" : "Funding window"}: ${escape(period(data.window.since))} to ${escape(period(data.window.as_of))}<br>Original TinySet collection: ${escape(timestamp(data.original.collected_at))}<br>Separate source review: ${data.review ? escape(timestamp(data.review.updated_at ?? data.review.checked_at)) : "not yet recorded"}<br>Unresolved or not reviewed: ${number(coverage.review_pending)}</p>${companyReviewOnly ? `<p class="notice"><strong>Company review only.</strong> This recorded investigation has a separate review of company funding and product fit. Investor candidates remain unverified; no reviewed investor shortlist is supplied for this brief.</p>` : ""}${supplement ? `<p class="case-meta"><strong>Public-source additions:</strong> ${number(publicCount)} companies, reviewed ${escape(timestamp(supplement.checked_at))}.</p><details class="case-meta"><summary>Research provenance</summary><p>${escape(supplement.scope)}</p></details>` : ""}<div class="metrics" aria-label="Investigation coverage"><div class="metric"><strong>${number(coverage.independently_reviewed_recent)}<span aria-hidden="true"> / </span><span class="small-label">${number(coverage.required)}</span></strong><span>${supplement ? "Combined reviewed recent companies" : "Reviewed recent companies"}</span></div><div class="metric"><strong>${number(coverage.returned_by_tinyset)}</strong><span>Original TinySet rows</span></div><div class="metric"><strong>${number(publicCount)}</strong><span>Public-source additions</span></div></div><div class="toolbar"><div class="tabs" role="tablist" aria-label="Investigation views">${tabs.map((tab) => `<button class="tab" type="button" id="tab-${tab}" role="tab" data-tab="${tab}" aria-controls="panel-${tab}" aria-selected="${state.tab === tab}" tabindex="${state.tab === tab ? "0" : "-1"}">${tabLabels[tab]}</button>`).join("")}</div><div class="export-group" aria-label="Export saved investigation"><a class="export-link" href="${escape(exports)}.json" download="funding-radar-case-${data.id}.json">JSON <span aria-hidden="true">↓</span></a><a class="export-link" href="${escape(exports)}.csv" download="funding-radar-case-${data.id}.csv">CSV <span aria-hidden="true">↓</span></a></div></div><div class="filter-row" id="research-filters"><input class="search-input" id="research-search" type="search" maxlength="200" autocomplete="off" aria-label="Search companies and investor candidates" placeholder="Search companies or investors…"><select class="status-filter" id="research-status" aria-label="Filter source review status"><option value="all">All source statuses</option><option value="verified_recent">Reviewed recent</option><option value="out_of_window">Outside window</option><option value="not_comparable">Not comparable</option><option value="unresolved">Unresolved</option><option value="not_reviewed">Not reviewed</option></select></div><p class="case-meta" id="result-count" role="status" aria-live="polite"></p>${tabs.map((tab) => `<div class="tab-panel" id="panel-${tab}" role="tabpanel" aria-labelledby="tab-${tab}" tabindex="0"${state.tab !== tab ? " hidden" : ""}></div>`).join("")}<div class="notice"><strong>Evidence before outreach.</strong> The parser retained ${number(coverage.provider_reported_qualifying)} provider-reported recent-company claims from ${number(coverage.returned_by_tinyset)} original rows. The independently reviewed count above is separate.${supplement ? ` It includes ${number(publicCount)} ordinary-web additions reviewed ${escape(timestamp(supplement.checked_at))}; these were not returned by TinySet and do not add to the original row count or candidate scores.` : ""} Investor scores are heuristics from retained provider claims after known exclusions, not verified matches or a current mandate. Check each evidence record before outreach. Complete reviewed records and conditional watchlist entries are separate from the unverified candidate scores. Conditional watchlist entries are not approach-ready. ${state.freshResearchEnabled ? "New live research starts only from your brief when you choose to run it." : "Live research is currently disabled; local planning remains available."}</div>`;
    renderResults();
  }

  function setTab(tab, focus = false) {
    if (!tabs.includes(tab) || !state.data) return;
    state.tab = tab;
    for (const name of tabs) {
      const button = document.querySelector(`#tab-${name}`);
      button.setAttribute("aria-selected", String(name === tab));
      button.tabIndex = name === tab ? 0 : -1;
      document.querySelector(`#panel-${name}`).hidden = name !== tab;
    }
    const filters = document.querySelector("#research-filters");
    filters.hidden = tab === "notes";
    filters.classList.toggle("filter-row", tab !== "notes");
    document.querySelector("#research-status").hidden = tab !== "companies";
    renderResults();
    if (focus) document.querySelector(`#tab-${tab}`).focus();
  }

  function renderResults() {
    if (!state.data) return;
    const panel = document.querySelector(`#panel-${state.tab}`);
    if (state.tab === "companies") renderCompanies(panel);
    else if (state.tab === "investors") renderInvestors(panel);
    else renderNotes(panel);
  }

  function matches(value) {
    return !state.query || normalize(value).includes(normalize(state.query));
  }

  function renderCompanies(panel) {
    const rows = state.data.rows
      .map((row, index) => ({ row, index }))
      .filter(
        ({ row }) =>
          (state.status === "all" || row.source_status === state.status) &&
          matches(
            [
              row.company_name,
              row.investor_name,
              row.round_stage,
              ...array(row.review?.notes),
            ].join(" "),
          ),
      );
    document.querySelector("#result-count").textContent =
      `${rows.length} of ${state.data.rows.length} presented company source records shown. ${number(state.data.coverage.returned_by_tinyset)} original TinySet rows; ${number(state.data.coverage.ordinary_web_supplement_companies ?? 0)} public-source additions.`;
    if (!rows.length) {
      panel.innerHTML =
        '<div class="empty-state"><p>No companies match these filters.</p><button class="export-link" type="button" data-reset-filters>Clear search and status filter</button></div>';
      return;
    }
    panel.innerHTML = `<div class="table-scroll" tabindex="0" role="region" aria-label="Company research table. Scroll horizontally for all columns."><table><caption class="small-label">Original TinySet claims and separate public-source additions with review decisions</caption><thead><tr><th scope="col">COMPANY</th><th scope="col">ROUND / STAGE</th><th scope="col">ANNOUNCEMENT</th><th scope="col">SOURCE REVIEW</th><th scope="col">INSPECT</th></tr></thead><tbody>${rows.map(({ row, index }) => `<tr><th scope="row"><button class="company-button" type="button" data-row="${index}">${escape(string(row.company_name, "Unnamed company"))}</button><small>${isPublicAddition(row) ? '<span class="tag">Public-source addition</span>' : "Original TinySet row"}</small></th><td>${escape(string(row.round_stage, "Unknown"))}<small>${escape(string(row.investor_name, "Investor unresolved"))}</small></td><td>${escape(period(row.announced_on, row.announced_month))}<small>${isPublicAddition(row) ? "Public-source announcement" : `Parsed provider claim${row.review ? `<br>Review: ${escape(period(row.review.announced_on, row.review.announced_month))}` : ""}`}</small></td><td>${badge(row.source_status)}</td><td><button class="arrow-button" type="button" data-row="${index}" aria-label="Inspect evidence for ${escape(string(row.company_name, "this company"))}">↗</button></td></tr>`).join("")}</tbody></table></div>`;
  }

  function shortlistEntries() {
    return array(state.data?.reviewed_shortlist?.investors)
      .map((investor, index) => ({ investor, index }))
      .filter(({ investor }) =>
        matches(
          [
            investor.investor_name,
            ...array(investor.reasons),
            ...array(investor.cautions),
            ...array(investor.similar_companies).map(
              (company) => company.company_name,
            ),
          ].join(" "),
        ),
      );
  }

  const usableShortlistInvestor = (investor) =>
    investor.evidence_complete === true && investor.approach_ready === true;

  function shortlistCardHtml({ investor, index }, conditional = false) {
    return `<button class="investor-card shortlist-card" type="button" data-shortlist="${index}"><span class="shortlist-rank">${conditional ? "WATCH" : escape(number(investor.rank)).padStart(2, "0")}</span><span class="score" aria-label="Reviewed research score ${number(investor.score)}">${number(investor.score)} fit points</span><h4>${escape(string(investor.investor_name, "Investor research"))}</h4><p>${escape(string(array(investor.reasons)[0], "Open the sourced explanation for this record."))}</p><dl class="card-facts"><dt>Typical cheque</dt><dd>${escape(chequeSummary(investor.typical_cheque))}</dd><dt>Stage</dt><dd>${escape(string(investor.stage_focus?.summary, array(investor.stage_focus?.values).join(", ") || "Not established"))}</dd><dt>Geography</dt><dd>${escape(string(investor.geography_focus?.summary, array(investor.geography_focus?.values).join(", ") || "Not established; confirm geography fit"))}</dd></dl>${array(investor.cautions).length ? `<div class="card-qualifications"><strong>Qualifications</strong>${list(investor.cautions, "card-cautions")}</div>` : ""}<span class="candidate-label">${conditional ? "CONDITIONAL WATCHLIST · CHECK EVIDENCE AND LIMITS" : "SOURCED RESEARCH · CHECK FIT QUALIFICATIONS"} · INSPECT ↗</span></button>`;
  }

  function reviewedShortlistHtml(entries) {
    const review = state.data.reviewed_shortlist;
    if (!review) return "";
    const usable = entries.filter(({ investor }) =>
      usableShortlistInvestor(investor),
    );
    const conditional = entries.filter(
      ({ investor }) => !usableShortlistInvestor(investor),
    );
    return `<section class="reviewed-shortlist" aria-labelledby="shortlist-title"><div class="shortlist-heading"><div><span class="small-label">FOLLOW THE INVESTMENT</span><h3 id="shortlist-title">Reviewed shortlist</h3></div><span class="tag good">SOURCED RESEARCH</span></div><p class="case-meta">Checked ${escape(timestamp(review.checked_at))}. ${escape(string(review.scope, "Open each investor to inspect the evidence and its limits."))}</p><p class="shortlist-help">Sourced research helps you assess a possible fit. Stage, geography and the qualifications on each card remain conditions of that fit. This is not a funding offer or a promise of interest.</p>${usable.length ? `<div class="investor-grid shortlist-grid">${usable.map((entry) => shortlistCardHtml(entry)).join("")}</div>` : `<p class="empty-state">${entries.length ? "No complete shortlist records match this search. Conditional records are shown below." : "No reviewed shortlist investors match this search."}</p>`}${conditional.length ? `<section aria-labelledby="watchlist-title"><h4 class="candidate-section-heading" id="watchlist-title">Conditional watchlist</h4><p class="shortlist-help">These records have unresolved evidence or fit conditions. They are watchlist research, not recommendations to approach an investor.</p><div class="investor-grid shortlist-grid">${conditional.map((entry) => shortlistCardHtml(entry, true)).join("")}</div></section>` : ""}</section>`;
  }

  function renderInvestors(panel) {
    const shortlist = shortlistEntries();
    const candidates = state.data.investor_candidates
      .map((investor, index) => ({ investor, index }))
      .filter(({ investor }) =>
        matches(
          [
            investor.investor_name,
            ...array(investor.similar_companies).map(
              (company) => company.company_name,
            ),
            ...array(investor.reasons),
          ].join(" "),
        ),
      );
    const reviewed = investorReviews()
      .map((entry, index) => ({ ...entry, index }))
      .filter(({ investor }) =>
        matches(
          [
            investor.name,
            ...array(investor.facts).map((fact) => fact.value),
          ].join(" "),
        ),
      );
    document.querySelector("#result-count").textContent =
      `${shortlist.filter(({ investor }) => usableShortlistInvestor(investor)).length} complete shortlist records, ${shortlist.filter(({ investor }) => !usableShortlistInvestor(investor)).length} conditional watchlist records, ${candidates.length} heuristic candidates and ${reviewed.length} separate investor fact reviews shown.`;
    panel.innerHTML = `${reviewedShortlistHtml(shortlist)}<h3 class="candidate-section-heading">Heuristic candidates</h3><p class="notice"><strong>Research candidates require review.</strong> Scores are recalculated after excluding contradicted or non-comparable rounds. Remaining provider claims are still unverified, and missing cheque, exact deal-partner and contact facts do not earn points. These original candidate scores are separate from the reviewed shortlist above.</p>${
      candidates.length
        ? `<div class="investor-grid">${candidates
            .map(
              ({ investor, index }) =>
                `<button class="investor-card" type="button" data-investor="${index}"><span class="score" aria-label="Candidate heuristic score ${number(investor.score)}">${number(investor.score)}</span><h4>${escape(investor.investor_name)}</h4><p>${escape(
                  array(investor.similar_companies)
                    .map((company) => company.company_name)
                    .join(" · "),
                )}</p><span class="candidate-label">CANDIDATE FIT · REVIEW REQUIRED ↗</span></button>`,
            )
            .join("")}</div>`
        : '<p class="empty-state">No original investor candidates match this search.</p>'
    }${reviewed.length ? `<h3>Separate investor fact reviews</h3><p class="case-meta">These dated findings do not add a verified match or contribute points to the candidate ranking.</p><div class="investor-grid">${reviewed.map(({ investor, index, origin }) => `<button class="investor-card" type="button" data-investor-review="${index}"><h4>${escape(investor.name)}</h4><p>${array(investor.facts).length} recorded findings. Open to inspect support and limits.</p><span class="candidate-label">${escape(origin)} ↗</span></button>`).join("")}</div>` : ""}`;
  }

  function renderNotes(panel) {
    const data = state.data;
    const supplement = data.public_source_supplement;
    document.querySelector("#result-count").textContent = [
      data.review
        ? `Separate review recorded ${timestamp(data.review.updated_at ?? data.review.checked_at)}.`
        : "No separate source review has been recorded for this investigation.",
      supplement
        ? `Public-source supplement recorded ${timestamp(supplement.checked_at)}.`
        : "No public-source additions are recorded.",
    ].join(" ");
    panel.innerHTML = `<h3>What this investigation establishes</h3><p class="description">${escape(data.warning)}</p>${data.review ? `<div class="source-block"><span class="source-title">Dated review scope</span><p>${escape(data.review.scope)}</p></div>` : '<p class="notice">Original TinySet research is available. It has not been upgraded to independent source verification.</p>'}${supplement ? `<div class="source-block"><span class="source-title">Public-source supplement scope</span><p>${escape(supplement.scope)}</p><p class="case-meta">Reviewed ${escape(timestamp(supplement.checked_at))}. ${number(supplement.company_count)} separately researched companies; none returned by TinySet. These additions do not change the original provider receipt or candidate scores.</p></div>` : ""}<h3>Open evidence gaps</h3>${array(data.blockers).length ? list(data.blockers) : '<p class="description">No additional blockers were returned. This alone does not establish submission readiness.</p>'}<h3>Keep the provenance</h3>${facts(
      [
        ["Dataset", string(data.original.dataset_id)],
        ["Run", string(data.original.run_id)],
        ["Original collection", timestamp(data.original.collected_at)],
        [
          "Review time",
          data.review
            ? timestamp(data.review.updated_at ?? data.review.checked_at)
            : "Not recorded",
        ],
        ["Original SHA-256", string(data.original.observations_sha256)],
        ["Original TinySet rows", number(data.coverage.returned_by_tinyset)],
        [
          "Public-source additions",
          number(data.coverage.ordinary_web_supplement_companies ?? 0),
        ],
        [
          "Public-source review time",
          supplement ? timestamp(supplement.checked_at) : "Not recorded",
        ],
        [
          "Public-source supplement SHA-256",
          supplement ? string(supplement.sha256) : "Not recorded",
        ],
        [
          "Live research",
          state.freshResearchEnabled
            ? "Available by explicit choice in your brief; never starts automatically."
            : "Disabled; local planning remains available.",
        ],
      ],
    )}<p class="notice">JSON and CSV exports preserve these evidence boundaries. A historical investment does not establish current investor interest. No messages or applications are sent.</p>`;
  }

  function showDetail(html, opener) {
    if (!detailDialog.open) detailOpener = opener ?? document.activeElement;
    detailContent.innerHTML = html;
    if (!detailDialog.open) detailDialog.showModal();
    const title = document.querySelector("#dialog-title");
    if (title) {
      title.tabIndex = -1;
      title.focus();
    }
  }

  function reviewSource(source) {
    return `<div class="source-block"><span class="source-title">${sourceLink(source.url, string(source.kind, "Review source"))}</span><small> · supports ${escape(array(source.supports).join(", ") || "see review note")}</small><p>${escape(source.note)}</p></div>`;
  }

  function openPublicRow(row, opener) {
    const review = row.review;
    const supplement = state.data.public_source_supplement;
    showDetail(
      `<div class="dialog-body"><h2 id="dialog-title">${escape(string(row.company_name, "Company evidence"))}</h2><p>${sourceLink(row.company_url, "Company website")} · ${badge(row.source_status)}</p><h3>Public-source addition</h3><p>This company was researched separately through ordinary public-web sources. It was not returned by TinySet and has no original provider claim.</p>${facts(
        [
          [
            "Reviewed announcement",
            period(row.announced_on, row.announced_month),
          ],
          ["Sourced stage", string(row.round_stage)],
          ["Geography", string(row.geography)],
          ["Sourced investors", string(row.investor_name)],
          [
            "Public-source review",
            timestamp(supplement?.checked_at ?? row.evidence?.collected_at),
          ],
        ],
      )}<div class="source-block"><span class="source-title">Comparable fit</span><p>${escape(string(row.evidence?.summary))}</p></div>${supplement ? `<div class="source-block"><span class="source-title">Public-source supplement scope</span><p>${escape(supplement.scope)}</p></div>` : ""}<h3>Source review and supporting pages</h3>${review ? `${list(review.notes)}${array(review.withheld_fields).length ? `<p class="notice"><strong>Withheld fields:</strong> ${escape(review.withheld_fields.map((field) => field.replaceAll("_", " ")).join(", "))}. This public-source review does not establish these facts.</p>` : ""}${array(review.sources).map(reviewSource).join("")}` : "<p>No source-review details are available for this addition.</p>"}${array(row.unknowns).length ? `<h3>Unestablished fields</h3>${list(row.unknowns)}` : ""}<p class="notice">Public-source additions contribute to combined reviewed company coverage, not original TinySet row counts or the candidate ranking. A quote or board appointment does not by itself establish a personal deal leader. This is not an approach-ready investor match.</p></div>`,
      opener,
    );
  }

  function openRow(index, opener) {
    const row = state.data?.rows[index];
    if (!row) return;
    if (isPublicAddition(row)) {
      openPublicRow(row, opener);
      return;
    }
    const claim =
      row.original_claim && typeof row.original_claim === "object"
        ? row.original_claim
        : row;
    const evidence = claim.evidence ?? row.evidence;
    const originalDay = claim.announced_on;
    const originalMonth = claim.announced_month;
    const review = row.review;
    const originalSource = claim.evidence_url ?? evidence?.url;
    const originalSummary = claim.evidence_summary ?? evidence?.summary;
    showDetail(
      `<div class="dialog-body"><h2 id="dialog-title">${escape(string(row.company_name, "Company evidence"))}</h2><p>${sourceLink(row.company_url, "Company website")} · ${badge(row.source_status)}</p><h3>${row.original_claim ? "Original TinySet claim" : "Parsed provider claim"}</h3><p>This is the recorded provider's claim, not an independently verified fact.</p>${facts(
        [
          [
            row.original_claim
              ? "Provider announcement"
              : "Date retained by parser",
            period(originalDay, originalMonth),
          ],
          ["Reported stage", string(claim.round_stage)],
          ["Reported investor", string(claim.investor_name)],
          ["Collected", timestamp(state.data.original.collected_at)],
        ],
      )}<div class="source-block"><span class="source-title">${sourceLink(originalSource, "Original claimed source")}</span><p>${escape(string(originalSummary, "No qualifying evidence summary was retained by the parser. The missing value is not a verified negative finding."))}</p></div><h3>Separate source review</h3>${review ? `<p class="case-meta">Reviewed ${escape(timestamp(state.data.review?.updated_at ?? state.data.review?.checked_at))}. ${escape(decisions[review.decision]?.text ?? "Review decision unavailable")}.</p>${facts([["Reviewed announcement", period(review.announced_on, review.announced_month)]])}${list(review.notes)}${array(review.withheld_fields).length ? `<p class="notice"><strong>Withheld fields:</strong> ${escape(review.withheld_fields.map((field) => field.replaceAll("_", " ")).join(", "))}. These are not silently restored by the original provider claim.</p>` : ""}${array(review.sources).map(reviewSource).join("")}` : "<p>No separate source review is recorded. Keep the provider claim unverified.</p>"}${array(row.unknowns).length ? `<h3>Original parser uncertainties</h3>${list(row.unknowns)}` : ""}<p class="notice">A page update is not necessarily a funding announcement. A commenting executive is not automatically the transaction lead. A round total is not an individual cheque.</p></div>`,
      opener,
    );
  }

  function factLabel(field) {
    return (
      {
        typical_cheque: "Typical cheque",
        stage: "Stage focus",
        deal_partner: "Exact deal partner",
        contact: "Contact route",
      }[field] ?? "Investor finding"
    );
  }

  function investorReviewHtml(review) {
    if (!review)
      return "<p>No separate investor fact review is recorded for this candidate.</p>";
    return (
      array(review.facts)
        .map(
          (fact) =>
            `<div class="source-block"><span class="source-title">${escape(factLabel(fact.field))} · ${escape(string(fact.status, "unknown"))}</span><p><strong>${escape(string(fact.value, "Not established"))}</strong></p><p>${escape(fact.note)}</p>${array(
              fact.source_urls,
            )
              .map((url) => `<p>${sourceLink(url, "Supporting source")}</p>`)
              .join("")}</div>`,
        )
        .join("") || "<p>No individual investor facts are recorded.</p>"
    );
  }

  function openInvestor(index, opener) {
    const investor = state.data?.investor_candidates[index];
    if (!investor) return;
    const reviews = investorReviews().filter(
      (entry) =>
        normalize(entry.investor.name) === normalize(investor.investor_name),
    );
    const companies = array(investor.similar_companies);
    showDetail(
      `<div class="dialog-body"><h2 id="dialog-title">${escape(investor.investor_name)}</h2><p>${sourceLink(investor.investor_url, "Investor website")}</p><div class="notice"><strong>Candidate heuristic score: ${number(investor.score)}.</strong> This score uses retained provider claims after excluding contradicted or non-comparable rounds. Separate reviewed investor details do not earn points. This candidate is not an approach-ready or fully verified match.</div><h3>Why this candidate score was awarded</h3>${list(investor.reasons)}<h3>Retained provider-reported comparable claims</h3>${companies
        .map((company) => {
          const rowIndex = state.data.rows.findIndex(
            (row) => row.company_name === company.company_name,
          );
          const row = state.data.rows[rowIndex];
          return `<div class="source-block"><strong>${escape(company.company_name)}</strong><p>${escape(string(company.round_stage, "Stage unknown"))} · ${escape(period(company.announced_on, company.announced_month))}</p>${row ? `${badge(row.source_status)} <button class="export-link" type="button" data-dialog-row="${rowIndex}">Inspect company evidence ↗</button>` : ""}<p>${sourceLink(company.evidence?.url, "Original investment source")}</p></div>`;
        })
        .join(
          "",
        )}<h3>Separate investor fact reviews</h3>${reviews.length ? reviews.map((entry) => `<p class="case-meta">${escape(entry.origin)}: ${escape(timestamp(entry.checkedAt))}</p>${investorReviewHtml(entry.investor)}`).join("") : investorReviewHtml(null)}<h3>Original parser uncertainties</h3>${array(investor.unknowns).length ? list(investor.unknowns) : "<p>No parser uncertainties were returned. This is not independent verification.</p>"}<p class="notice">A verified portfolio relationship alone does not establish a typical cheque, current mandate, exact deal leader or open intake. No outreach is sent.</p></div>`,
      opener,
    );
  }

  function openShortlistInvestor(index, opener) {
    const investor = array(state.data?.reviewed_shortlist?.investors)[index];
    if (!investor) return;
    const review = state.data.reviewed_shortlist;
    const conditional = !usableShortlistInvestor(investor);
    const policy = (title, value, extra = "") =>
      `<div class="source-block"><h3>${escape(title)}</h3><p><strong>${escape(value)}</strong></p>${extra}</div>`;
    const companies = array(investor.similar_companies)
      .map((company) => {
        const lead = company.lead ?? {};
        return `<div class="source-block"><h3>${escape(string(company.company_name, "Comparable company"))}</h3><p>${sourceLink(company.company_url, "Company website")}</p>${facts(
          [
            [
              "Announcement",
              period(company.announced_on, company.announced_month),
            ],
            ["Round stage", string(company.round_stage)],
            ["Named person", string(lead.name)],
            ["Recorded title", string(lead.title)],
            ["Role in this investment", string(lead.role)],
            ["Current / historical status", string(lead.current_status)],
          ],
        )}<p>${escape(string(lead.summary))}</p><p><strong>Attribution and limits:</strong> ${escape(string(lead.qualification))}</p><h4>Proof of the investment</h4>${supportingLinks(company.investment_source_urls) || "<p>No investment proof link provided.</p>"}<h4>Proof of the named role</h4>${supportingLinks(lead.source_urls) || "<p>No named-role proof link provided.</p>"}</div>`;
      })
      .join("");
    const contact = investor.contact_route ?? {};
    showDetail(
      `<div class="dialog-body"><span class="small-label">${conditional ? "CONDITIONAL WATCHLIST · RESEARCH RECORD" : `REVIEWED SHORTLIST · RANK ${number(investor.rank)}`}</span><h2 id="dialog-title">${escape(string(investor.investor_name, "Investor research"))}</h2><p>${sourceLink(investor.investor_url, "Investor website")}</p><p class="case-meta">Checked ${escape(timestamp(review.checked_at))}. ${escape(string(review.scope, "Dated source review."))}</p><p class="notice"><strong>${investor.evidence_complete === true && investor.approach_ready === true ? "Source fields complete; fit remains conditional." : "Check evidence and qualifications."}</strong> Historical investment evidence does not promise current interest, eligibility, available capital or a response. No outreach is sent. A named person’s exact investment role may differ from overall round leadership; retain the attribution below.</p>${array(investor.cautions).length ? `<h3>Qualifications before outreach</h3>${list(investor.cautions)}` : ""}<h3>${conditional ? "Why this investor is on the watchlist" : "Why this investor ranks here"}</h3>${list(investor.reasons)}<h3>Fit score: ${number(investor.score)}</h3><p>This is an explained research score, not a probability of funding.</p>${array(
        investor.score_breakdown,
      )
        .map(
          (part) =>
            `<div class="score-part"><strong>${escape(string(part.label, "Fit factor"))}<span>${Number.isFinite(part.points) ? escape(part.points) : "Unknown"} points</span></strong><p>${escape(string(part.detail))}</p></div>`,
        )
        .join(
          "",
        )}${policy("Typical cheque", chequeSummary(investor.typical_cheque), `<p><strong>Scope:</strong> ${escape(string(investor.typical_cheque?.scope))}</p><p>${escape(string(investor.typical_cheque?.summary))}</p>${supportingLinks(investor.typical_cheque?.source_urls)}`)}${policy("Stage focus", string(investor.stage_focus?.summary, array(investor.stage_focus?.values).join(", ") || "Not established"), supportingLinks(investor.stage_focus?.source_urls))}${policy("Geography focus", string(investor.geography_focus?.summary, array(investor.geography_focus?.values).join(", ") || "Not established"), supportingLinks(investor.geography_focus?.source_urls))}<h3>Similar companies and the people behind the investment</h3>${companies || "<p>No comparable-company evidence was supplied.</p>"}<h3>Published contact route</h3>${facts(
        [
          [
            "Route type",
            {
              founder_form: "Founder application",
              investment_email: "Published investment contact",
              open_intake: "Open intake",
              warm_intro: "Warm introduction",
            }[contact.type] ?? "Published contact",
          ],
          ["Published email", string(contact.email)],
        ],
      )}<p>${escape(string(contact.summary))}</p><p>${sourceLink(contact.url, "Official contact or intake route")}</p>${supportingLinks(contact.source_urls)}</div>`,
      opener,
    );
  }

  function openInvestorReview(index, opener) {
    const entry = investorReviews()[index];
    if (!entry) return;
    const { investor, origin, checkedAt } = entry;
    showDetail(
      `<div class="dialog-body"><h2 id="dialog-title">${escape(investor.name)}</h2><p class="case-meta">${escape(origin)}: ${escape(timestamp(checkedAt))}</p><p class="notice">Dated fact review only. This is not a newly ranked investor, proof of a complete match or an approach-ready recommendation. Public-source supplement findings were not returned by TinySet.</p>${investorReviewHtml(investor)}</div>`,
      opener,
    );
  }

  function updateLiveControls() {
    const job = state.liveJob;
    const limits = configuredLiveLimits();
    const available = state.freshResearchEnabled && limits;
    const active =
      job &&
      (job.reconciliationRequired ||
        ["starting", "running", "uncertain", "cancelling"].includes(
          job.status,
        ));
    liveControls.hidden = !state.freshResearchEnabled && !job;
    liveButton.hidden = !state.freshResearchEnabled;
    liveButton.disabled = !available || Boolean(active);
    document.querySelector("#live-limit-summary").textContent = limits
      ? `Paid TinySet research: up to ${limits.target_rows} company rows. Maximum estimated cost: ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(limits.maximum_estimated_cost_usd)} USD.`
      : "Configured row ceiling and estimated cost could not be read. Paid research stays disabled until these limits can be shown.";
    document.querySelector("#live-price-note").textContent =
      limits?.price_note ?? "";
    cancelButton.hidden = !active || Boolean(job?.cancellationUnavailable);
    cancelButton.disabled = ["starting", "cancelling"].includes(job?.status);
    checkButton.hidden = job?.status !== "uncertain";
    try {
      if (active)
        sessionStorage.setItem(
          "funding-radar-active-research",
          JSON.stringify(job),
        );
      else sessionStorage.removeItem("funding-radar-active-research");
    } catch {
      /* Status is still available for this page if optional tab storage is unavailable. */
    }
    const note = document.querySelector("#live-availability");
    const help = document.querySelector("#live-availability-help");
    note.textContent = available
      ? "Live research available"
      : state.freshResearchEnabled
        ? "Live limits unavailable"
        : "Live research disabled";
    help.textContent = available
      ? "Saved evidence and local plans use no credits. Review the paid row and cost limits in your brief before starting."
      : "Browse saved evidence or prepare a plan. Neither uses provider credits.";
    if (!job) return;
    const messages = {
      starting:
        "Sending your research request. This request will not be repeated automatically.",
      running: job.cancellationRequested
        ? "Cancellation has been requested. The server has not confirmed a final state; the run remains held."
        : "TinySet research is running. You can keep browsing, or request cancellation below.",
      cancelling:
        "Cancellation requested. Waiting for the server to confirm the final state.",
      cancelled:
        "This research was cancelled. Cancellation does not imply that earlier provider work was uncharged.",
      complete:
        "Research completed. New provider findings remain unverified unless a separate source review is supplied.",
      failed: "The research did not complete. No automatic retry was made.",
      uncertain: job.reconciliationRequired
        ? "This request requires reconciliation. Its provider state is unresolved; another paid start is disabled."
        : "We could not confirm the latest state. The request is held to avoid starting a duplicate. Check this same run or request cancellation.",
    };
    const message = `<p class="live-state ${job.status === "failed" || job.status === "uncertain" ? "error-message" : ""}"><strong>${escape(messages[job.status] ?? "Check the research status.")}</strong></p>${job.error ? `<p>${escape(job.error)}</p>` : ""}${job.reconciliationRequired ? "<p>Keep this request ID. Ask the app operator to confirm the provider's final state and retained allowance before starting another run. A missing local record does not prove the provider stopped. This page will not resend the request or create a replacement.</p>" : ""}${job.cancellationUnavailable ? "<p>Cancellation cannot be confirmed through this local request. No cancellation success is claimed.</p>" : ""}<p class="case-meta">Request ${escape(job.requestId)}<br>Brief: ${escape(job.description)}</p>${job.status === "complete" ? `<button class="button primary" type="button" id="view-research">${isRecordedCase(state.cases.find((entry) => entry.id === job.requestId)) ? "View recorded investigation" : "View new investigation"} ↗</button>` : ""}`;
    if (liveStatus.innerHTML !== message) liveStatus.innerHTML = message;
  }

  function validatedDescription() {
    const description = descriptionInput.value.trim();
    descriptionInput.setCustomValidity(
      description.length < 15 || description.length > 1000
        ? "Enter a startup description of 15 to 1,000 characters."
        : "",
    );
    return briefForm.reportValidity() ? description : null;
  }

  async function acceptResearchStatus(job, payload) {
    if (state.liveJob !== job) return;
    if (
      payload?.request_id !== job.requestId ||
      !["running", "complete", "failed", "cancelled"].includes(payload.status)
    )
      throw new Error(
        "The server returned an unexpected research state. No new request was made.",
      );
    job.accepted = true;
    job.errorCode = payload.error?.code ?? null;
    job.cancellationRequested = Boolean(
      job.cancellationRequested || payload.cancellation_requested,
    );
    if (job.errorCode === "REMOTE_STATE_UNCERTAIN") {
      job.reconciliationRequired = true;
      job.cancellationUnavailable = true;
    }
    if (
      job.reconciliationRequired &&
      !["complete", "cancelled"].includes(payload.status)
    ) {
      clearTimeout(pollTimer);
      job.status = "uncertain";
      job.error = string(
        payload.error?.message,
        "The provider's final state still needs to be reconciled.",
      );
      updateLiveControls();
      return;
    }
    job.status = payload.status;
    job.reconciliationRequired = false;
    job.cancellationUnavailable = false;
    job.error = payload.error
      ? string(payload.error.message, "The server reported an error.")
      : null;
    updateLiveControls();
    if (job.status === "running") {
      pollTimer = setTimeout(() => void pollResearch(job), 2000);
    } else if (job.status === "complete") {
      const expectedResult = casePath(job.requestId);
      if (payload.result_url !== expectedResult)
        throw new Error(
          "The result location could not be confirmed. Check this same run before continuing.",
        );
      const opened = await loadCase(job.requestId);
      toast(
        opened
          ? "New investigation available. Check the evidence before using its findings."
          : "Research completed, but its report could not be opened. You can try opening it again.",
      );
    }
  }

  async function pollResearch(job = state.liveJob) {
    if (!job || state.liveJob !== job) return;
    clearTimeout(pollTimer);
    jobController?.abort();
    jobController = new AbortController();
    try {
      const payload = await requestJson(job.statusUrl, {
        signal: jobController.signal,
      });
      await acceptResearchStatus(job, payload);
    } catch (error) {
      if (error.name === "AbortError" || state.liveJob !== job) return;
      job.status = "uncertain";
      job.errorCode = error.code ?? null;
      if (error.status === 404) {
        job.reconciliationRequired = true;
        job.cancellationUnavailable = true;
      }
      job.error =
        error.status === 404
          ? "The server cannot find this local request, possibly after a restart. Acceptance, provider termination and any charge cannot be inferred from this missing record."
          : error.message;
      updateLiveControls();
    }
  }

  async function startResearch() {
    if (
      !state.freshResearchEnabled ||
      !configuredLiveLimits() ||
      (state.liveJob &&
        (state.liveJob.reconciliationRequired ||
          ["starting", "running", "uncertain", "cancelling"].includes(
            state.liveJob.status,
          )))
    )
      return;
    const description = validatedDescription();
    if (!description) return;
    if (typeof crypto.randomUUID !== "function") {
      toast(
        "This browser cannot create a unique research request. No research was started.",
      );
      return;
    }
    const requestId = crypto.randomUUID();
    const job = {
      requestId,
      statusUrl: `/api/research/${requestId}`,
      status: "starting",
      description,
      error: null,
      accepted: false,
      reconciliationRequired: false,
      cancellationUnavailable: false,
    };
    state.liveJob = job;
    updateLiveControls();
    liveStatus.focus();
    try {
      const payload = await requestJson("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description, request_id: requestId }),
      });
      if (payload?.status_url !== job.statusUrl)
        throw new Error(
          "The accepted request location could not be confirmed. Check this same run before continuing.",
        );
      await acceptResearchStatus(job, payload);
    } catch (error) {
      job.status = "uncertain";
      job.error = error.message;
      updateLiveControls();
    }
  }

  async function cancelResearch() {
    const job = state.liveJob;
    if (
      !job ||
      job.cancellationUnavailable ||
      !["running", "uncertain"].includes(job.status)
    )
      return;
    clearTimeout(pollTimer);
    jobController?.abort();
    job.status = "cancelling";
    job.cancellationRequested = true;
    job.error = null;
    updateLiveControls();
    try {
      const payload = await requestJson(job.statusUrl + "/cancel", {
        method: "POST",
      });
      await acceptResearchStatus(job, payload);
    } catch (error) {
      job.status = "uncertain";
      job.errorCode = error.code ?? null;
      if (error.status === 404) {
        job.reconciliationRequired = true;
        job.cancellationUnavailable = true;
      }
      job.error =
        error.status === 404
          ? "The local request was not found. Cancellation was not confirmed, and the provider's final state remains unresolved."
          : error.message;
      updateLiveControls();
    }
  }

  function openBrief(opener) {
    if (briefDialog.open) return;
    briefOpener = opener ?? document.activeElement;
    briefDialog.showModal();
    descriptionInput.focus();
  }

  async function preparePlan(event) {
    event.preventDefault();
    const description = validatedDescription();
    if (!description) return;
    prepareButton.disabled = true;
    prepareButton.textContent = "Preparing your plan…";
    briefForm.setAttribute("aria-busy", "true");
    planResult.innerHTML =
      '<p role="status">Preparing a local research plan. No live operation will start.</p>';
    if (planUrl) {
      URL.revokeObjectURL(planUrl);
      planUrl = undefined;
    }
    try {
      const plan = await requestJson("/api/plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ description }),
      });
      if (
        plan?.provider_calls !== 0 ||
        plan?.live_dispatch_allowed !== false ||
        plan?.body?.populate !== false ||
        !plan.window ||
        !plan.startup
      )
        throw new Error(
          "The response did not establish a local-only plan. No research was started.",
        );
      planUrl = URL.createObjectURL(
        new Blob([JSON.stringify(plan, null, 2) + "\n"], {
          type: "application/json",
        }),
      );
      planResult.innerHTML = `<div class="source-block"><h3>Your research plan is ready.</h3><p>${escape(plan.startup.description ?? description)}</p>${facts(
        [
          [
            "Parsed stage",
            string(
              plan.startup.stage,
              "Not recognised; retain in the full brief",
            ),
          ],
          [
            "Parsed country",
            string(
              plan.startup.geography,
              "Not recognised; retain in the full brief",
            ),
          ],
          [
            "Parsed sectors",
            array(plan.startup.sectors).join(", ") ||
              "No supported vocabulary match",
          ],
          [
            "Planned window",
            period(plan.window.since) + " to " + period(plan.window.as_of),
          ],
          ["Requested company rows", number(plan.body.target_rows)],
        ],
      )}<p>Local planning only. No research was started, no credits were reserved and no saved investigation changed. Parsed fields use a limited vocabulary; the full description is retained for review.</p><a class="button primary" id="download-plan" download="funding-radar-research-plan.json">Download plan JSON ↓</a></div>`;
      document.querySelector("#download-plan").href = planUrl;
      toast("Plan prepared locally. No live research started.");
    } catch (error) {
      planResult.innerHTML = `<p class="error-message" role="alert">${escape(error.message)}</p><p>Your description is retained. Edit it or press Prepare research plan to try again. No live research was started.</p>`;
    } finally {
      prepareButton.disabled = false;
      prepareButton.textContent = "Prepare research plan ↗";
      briefForm.setAttribute("aria-busy", "false");
    }
  }

  function resetFilters() {
    state.query = "";
    state.status = "all";
    document.querySelector("#research-search").value = "";
    document.querySelector("#research-status").value = "all";
    renderResults();
    document.querySelector("#research-search").focus();
  }

  function installMotionControl() {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "motion-toggle";
    let disabledByUser = false;
    try {
      disabledByUser = localStorage.getItem("funding-radar-motion") === "off";
    } catch {
      /* Storage is optional. */
    }
    function update() {
      document.documentElement.dataset.motion =
        disabledByUser || media.matches ? "off" : "on";
      button.disabled = media.matches;
      button.setAttribute(
        "aria-pressed",
        String(disabledByUser || media.matches),
      );
      button.setAttribute(
        "aria-label",
        media.matches
          ? "Motion is reduced by your system setting"
          : "Reduce interface motion",
      );
      button.textContent = media.matches
        ? "Motion reduced"
        : disabledByUser
          ? "Motion off"
          : "Motion on";
    }
    button.addEventListener("click", () => {
      disabledByUser = !disabledByUser;
      try {
        localStorage.setItem(
          "funding-radar-motion",
          disabledByUser ? "off" : "on",
        );
      } catch {
        /* The control still works without storage. */
      }
      update();
    });
    media.addEventListener("change", update);
    document.querySelector(".nav nav")?.append(button);
    update();
  }

  caseList.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-retry-cases")) void loadCases();
    else if (button.hasAttribute("data-case")) {
      const entry = state.cases.find(
        (item) => String(item.id) === button.dataset.case,
      );
      if (entry) void loadCase(entry.id);
    }
  });
  content.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-retry-cases")) void loadCases();
    else if (button.hasAttribute("data-retry-case"))
      void loadCase(state.selected);
    else if (button.hasAttribute("data-tab")) setTab(button.dataset.tab);
    else if (button.hasAttribute("data-row"))
      openRow(Number(button.dataset.row), button);
    else if (button.hasAttribute("data-shortlist"))
      openShortlistInvestor(Number(button.dataset.shortlist), button);
    else if (button.hasAttribute("data-investor"))
      openInvestor(Number(button.dataset.investor), button);
    else if (button.hasAttribute("data-investor-review"))
      openInvestorReview(Number(button.dataset.investorReview), button);
    else if (button.hasAttribute("data-reset-filters")) resetFilters();
    else if (button.hasAttribute("data-open-brief")) openBrief(button);
  });
  content.addEventListener("input", (event) => {
    if (event.target.id === "research-search") {
      state.query = event.target.value;
      renderResults();
    }
  });
  content.addEventListener("change", (event) => {
    if (event.target.id === "research-status") {
      state.status = event.target.value;
      renderResults();
    }
  });
  content.addEventListener("keydown", (event) => {
    const button = event.target.closest('[role="tab"]');
    if (
      !button ||
      !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    )
      return;
    event.preventDefault();
    const index = tabs.indexOf(button.dataset.tab);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
            tabs.length;
    setTab(tabs[next], true);
  });
  detailContent.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-dialog-row]");
    if (button) openRow(Number(button.dataset.dialogRow));
  });
  document
    .querySelector("#close-detail")
    .addEventListener("click", () => detailDialog.close());
  detailDialog.addEventListener("close", () => {
    if (detailOpener?.isConnected) detailOpener.focus();
  });
  document
    .querySelector("#new-brief")
    .addEventListener("click", (event) => openBrief(event.currentTarget));
  document
    .querySelector("#close-brief")
    .addEventListener("click", () => briefDialog.close());
  briefDialog.addEventListener("close", () => {
    if (briefOpener?.isConnected) briefOpener.focus();
  });
  for (const dialog of [detailDialog, briefDialog])
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        dialog.close();
    });
  descriptionInput.addEventListener("input", () =>
    descriptionInput.setCustomValidity(""),
  );
  briefForm.addEventListener("submit", preparePlan);
  liveButton.addEventListener("click", () => void startResearch());
  cancelButton.addEventListener("click", () => void cancelResearch());
  checkButton.addEventListener("click", () => void pollResearch());
  liveStatus.addEventListener("click", async (event) => {
    if (
      !event.target.closest("#view-research") ||
      state.liveJob?.status !== "complete"
    )
      return;
    if (state.data?.id !== state.liveJob.requestId)
      await loadCase(state.liveJob.requestId);
    briefDialog.close();
    document.querySelector("#workspace").scrollIntoView({ block: "start" });
    setTimeout(() => {
      const heading = content.querySelector(".case-heading h3") ?? content;
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }, 0);
  });
  window.addEventListener("pagehide", (event) => {
    caseController?.abort();
    clearTimeout(pollTimer);
    jobController?.abort();
    if (!event.persisted && planUrl) URL.revokeObjectURL(planUrl);
  });
  window.addEventListener("pageshow", (event) => {
    if (
      event.persisted &&
      state.liveJob &&
      ["starting", "running", "cancelling"].includes(state.liveJob.status)
    ) {
      state.liveJob.status = "uncertain";
      updateLiveControls();
    }
  });
  try {
    const saved = JSON.parse(
      sessionStorage.getItem("funding-radar-active-research") ?? "null",
    );
    if (
      saved &&
      isResearchId(saved.requestId) &&
      typeof saved.description === "string" &&
      saved.description.length <= 1000
    ) {
      state.liveJob = {
        requestId: saved.requestId,
        description: saved.description,
        statusUrl: `/api/research/${saved.requestId}`,
        status: "uncertain",
        accepted: saved.accepted === true,
        reconciliationRequired: saved.reconciliationRequired === true,
        cancellationUnavailable: saved.cancellationUnavailable === true,
        cancellationRequested: saved.cancellationRequested === true,
        error:
          saved.reconciliationRequired === true
            ? "This tab retains a request that requires provider-state reconciliation. No request has been repeated and no replacement has been created."
            : "This tab has a previous research request. Check its state before starting another; no request has been repeated.",
      };
    }
  } catch {
    /* Storage is optional; malformed local state cannot start research. */
  }
  installMotionControl();
  void loadCases();
})();
