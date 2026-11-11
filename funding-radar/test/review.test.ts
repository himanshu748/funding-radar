import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildReviewedCase, sha256 } from "../src/review.js";
const bytes = await readFile(
  new URL("../evidence/recent-2-observations.json", import.meta.url),
);
const description =
  "UK seed climate software startup building energy forecasting for grid operators";
const raw = JSON.parse(bytes.toString("utf8"));
const company = raw.rows[0];
function review() {
  return {
    format: "funding-radar-source-review-v1",
    case_id: 2,
    checked_at: "2026-11-10T10:00:00.000Z",
    method: "ordinary_web_primary_source_review",
    original_observations_sha256: sha256(bytes),
    scope:
      "Synthetic review contract test, not actual investment verification.",
    provider_operations_started: 0,
    blockers: [
      "Synthetic test review; no claim of real independent verification.",
    ],
    rows: [
      {
        row_id: company._id,
        company_name: company.data.company_name,
        decision: "out_of_window",
        announced_on: "2023-10-03",
        announced_month: "2023-10",
        notes: [
          "Synthetic boundary reproduces the historical financing date conflict.",
        ],
        sources: [
          {
            url: "https://example.com/announcement",
            kind: "company",
            supports: ["identity", "completed_round", "date", "fit"],
            note: "Synthetic source reference only; this test establishes no source truth.",
          },
        ],
        withheld_fields: ["lead_partner"],
      },
    ],
  };
}

test("a specifically withheld stage cannot survive in the derived view or earn candidate stage points", () => {
  const value = structuredClone(raw);
  value.mode = "synthetic_fixture";
  value.rows = [value.rows[0]];
  const row = value.rows[0];
  Object.assign(row.data, {
    announced_on: "2026-10-01",
    round_stage: "seed",
    investor_name: "Synthetic Stage Capital",
    investor_url: "https://stage-capital.example/",
    sector: "climate energy forecasting software",
    geography: "UK",
    evidence_url: row.data.company_url,
    evidence_summary: `${row.data.company_name} raised seed funding on 2026-10-01 from Synthetic Stage Capital for its UK climate energy forecasting software.`,
  });
  const original = Buffer.from(JSON.stringify(value));
  const before = buildReviewedCase(description, original);
  const overlay = review();
  overlay.original_observations_sha256 = sha256(original);
  Object.assign(overlay.rows[0]!, {
    decision: "verified_recent",
    announced_on: "2026-10-01",
    announced_month: null,
    withheld_fields: ["round_stage"],
    sources: [
      {
        url: row.data.company_url,
        kind: "company",
        supports: ["identity", "completed_round", "date", "fit"],
        note: "Synthetic test source supports the company/date/fit but does not establish the reported round stage.",
      },
    ],
  });
  const after = buildReviewedCase(description, original, overlay);
  assert.equal(after.rows[0]!.round_stage, null);
  assert.equal(after.rows[0]!.original_claim.round_stage, "seed");
  assert.equal(
    after.investor_candidates[0]!.score,
    before.investor_candidates[0]!.score - 20,
  );
  assert.deepEqual(after.investor_candidates[0]!.historical_stages, []);
  assert.equal(after.original.observations_sha256, sha256(original));
});
test("unreviewed provider claims cannot become independently verified or approach-ready", () => {
  const data = buildReviewedCase(description, bytes);
  assert.equal(data.coverage.independently_reviewed_recent, 0);
  assert.equal(data.submission_ready, false);
  assert.equal(data.fresh_research_enabled, false);
  assert.deepEqual(data.approach_ready_investors, []);
  assert.ok(data.investor_candidates.every((i) => !i.approach_ready));
});
test("source-review overlay preserves original bytes and exposes exact raw claim separately", () => {
  const originalHash = sha256(bytes);
  const result = buildReviewedCase(description, bytes, review());
  assert.equal(sha256(bytes), originalHash);
  assert.equal(result.rows[0]!.source_status, "out_of_window");
  assert.deepEqual(result.rows[0]!.original_claim, company.data);
  assert.equal(result.rows[0]!.review!.announced_on, "2023-10-03");
  assert.equal(result.coverage.contradicted_or_excluded, 1);
});
test("foreign original hash, foreign row, duplicate row and company mismatch fail closed", () => {
  const a = review();
  a.original_observations_sha256 = "0".repeat(64);
  assert.throws(() => buildReviewedCase(description, bytes, a));
  const b = review();
  b.rows[0]!.row_id = "foreign";
  assert.throws(() => buildReviewedCase(description, bytes, b));
  const c = review();
  c.rows.push(c.rows[0]!);
  assert.throws(() => buildReviewedCase(description, bytes, c));
  const d = review();
  d.rows[0]!.company_name = "Another company";
  assert.throws(() => buildReviewedCase(description, bytes, d));
});
test("a reviewer cannot verify a round outside the fixed historical window, infer missing facts, or use unsafe sources", () => {
  const a = review();
  a.rows[0]!.decision = "verified_recent";
  assert.throws(() => buildReviewedCase(description, bytes, a));
  const b = review();
  b.rows[0]!.decision = "verified_recent";
  b.rows[0]!.announced_on = "2025-10-01";
  b.rows[0]!.announced_month = "2025-10";
  b.rows[0]!.sources[0]!.supports = ["identity"];
  assert.throws(() => buildReviewedCase(description, bytes, b));
  const c = review();
  c.rows[0]!.sources[0]!.url = "javascript:alert(1)";
  assert.throws(() => buildReviewedCase(description, bytes, c));
});
test("month precision cannot count a partly overlapping month, and exact day and month must agree", () => {
  const a = review();
  a.rows[0]!.decision = "verified_recent";
  a.rows[0]!.announced_on = null as unknown as string;
  a.rows[0]!.announced_month = "2025-05";
  assert.throws(() => buildReviewedCase(description, bytes, a));
  const b = review();
  b.rows[0]!.decision = "verified_recent";
  b.rows[0]!.announced_on = "2025-10-01";
  b.rows[0]!.announced_month = "2025-11";
  assert.throws(() => buildReviewedCase(description, bytes, b));
});
test("contradicted-only investor evidence cannot survive into the reviewed candidate list", () => {
  const unreviewed = buildReviewedCase(description, bytes);
  const row = unreviewed.rows[0]!;
  const related = unreviewed.investor_candidates.filter((i) =>
    i.similar_companies.every((c) => c.company_name === row.company_name),
  );
  const result = buildReviewedCase(description, bytes, review());
  for (const i of related)
    assert.ok(
      !result.investor_candidates.some((candidate) => candidate.id === i.id),
    );
});

test("an excluded deal cannot inflate a surviving investor's score or evidence", () => {
  const synthetic = JSON.parse(bytes.toString("utf8"));
  const [retained, excluded] = synthetic.rows;
  const investorName = "Synthetic Review Regression Capital";
  for (const [index, row] of [retained, excluded].entries()) {
    Object.assign(row.data, {
      investor_name: investorName,
      investor_url: "https://example.com/investor",
      announced_on: "2025-10-01",
      round_stage: index === 0 ? "seed" : "Series A",
      sector: "climate energy forecasting software",
      geography: "UK",
      evidence_url: row.data.company_url,
      evidence_summary: `${row.data.company_name} raised ${index === 0 ? "seed" : "Series A"} funding on 2025-10-01 from ${investorName} for its UK climate energy forecasting business.`,
    });
  }
  const syntheticBytes = Buffer.from(JSON.stringify(synthetic));
  const baseline = buildReviewedCase(description, syntheticBytes);
  const before = baseline.investor_candidates.find(
    (candidate) => candidate.investor_name === investorName,
  )!;
  assert.equal(before.similar_companies.length, 2);

  const overlay = review();
  overlay.original_observations_sha256 = sha256(syntheticBytes);
  overlay.rows[0]!.row_id = excluded._id;
  overlay.rows[0]!.company_name = excluded.data.company_name;
  overlay.rows[0]!.decision = "not_comparable";
  const result = buildReviewedCase(description, syntheticBytes, overlay);
  const after = result.investor_candidates.find(
    (candidate) => candidate.investor_name === investorName,
  )!;

  assert.equal(
    result.rows.find((row) => row.row_id === excluded._id)!.source_status,
    "not_comparable",
  );
  assert.deepEqual(
    after.similar_companies.map((company) => company.company_name),
    [retained.data.company_name],
  );
  assert.equal(after.score, before.score - 10);
  assert.deepEqual(after.historical_stages, ["seed"]);
  assert.ok(
    after.reasons.some((reason) => reason.startsWith("+10: 1 distinct")),
  );
  assert.ok(!after.reasons.some((reason) => reason.includes("2 distinct")));
  assert.deepEqual(after.contact_routes, []);
  assert.equal(after.typical_cheque, null);
  assert.ok(
    after.similar_companies.every((company) => company.lead_partner === null),
  );
  assert.equal(sha256(syntheticBytes), overlay.original_observations_sha256);
});

test("missing review stays explicitly pending in provenance and warning", () => {
  const result = buildReviewedCase(description, bytes, undefined, 2);
  assert.equal(result.mode, "saved_live_review_pending");
  assert.equal(result.review, null);
  assert.match(result.warning, /independent source review is pending/i);
  assert.doesNotMatch(
    result.warning,
    /independently reviewed|separate dated source review/i,
  );
  assert.equal(result.coverage.independently_reviewed_recent, 0);
  assert.equal(result.coverage.review_pending, result.rows.length);
  assert.equal(result.coverage.complete, false);
});

test("review case ID must match the selected investigation even with the correct bytes", () => {
  assert.throws(
    () => buildReviewedCase(description, bytes, review(), 1),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "REVIEW_IDENTITY_MISMATCH",
  );
  assert.equal(
    buildReviewedCase(description, bytes, review(), 2).review!.case_id,
    2,
  );
});

test("future-dated reviews cannot establish verification", () => {
  const future = review();
  future.checked_at = new Date(Date.now() + 60_000).toISOString();
  assert.throws(
    () => buildReviewedCase(description, bytes, future, 2),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "REVIEW_TIME_INVALID",
  );
  const past = review();
  past.checked_at = new Date(Date.now() - 1_000).toISOString();
  assert.equal(
    buildReviewedCase(description, bytes, past, 2).review!.checked_at,
    past.checked_at,
  );
});

test("enriched review dates cannot precede the original review or lie in the future", () => {
  const earlier = { ...review(), updated_at: "2026-11-09T00:00:00.000Z" };
  assert.throws(() => buildReviewedCase(description, bytes, earlier));
  const future = {
    ...review(),
    updated_at: new Date(Date.now() + 60000).toISOString(),
  };
  assert.throws(() => buildReviewedCase(description, bytes, future));
  const valid = { ...review(), updated_at: new Date().toISOString() };
  assert.ok(buildReviewedCase(description, bytes, valid).review?.updated_at);
});
