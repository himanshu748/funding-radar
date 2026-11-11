import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { TinySetResult } from "../../providers/tinyset.js";
import { buildRecordedInvestigation } from "../src/recording.js";
import { rankRecentCompanies, type RecentCollection } from "../src/recent.js";
import { buildReviewedCase, sha256, type CaseReview } from "../src/review.js";
import { researchSnapshotDigest } from "../src/reviewed-ranking.js";

// Read-only genuine export replay, not a fresh provider test. Mutations below
// affect in-memory copies only and must never become execution evidence.
const genuineBytes = readFileSync(
  new URL(
    "../evidence/recorded-investigations/fresh-security-export.json",
    import.meta.url,
  ),
);
const genuineReview: CaseReview = JSON.parse(
  readFileSync(
    new URL(
      "../evidence/recorded-investigations/fresh-security-review.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
interface ExportCopy {
  format: string;
  id: string;
  description: string;
  mode: string;
  collection_mode: string;
  original: {
    dataset_id: string;
    run_id: string;
    collected_at: string;
    observations_sha256: string;
  };
  provider_result: {
    observations: RecentCollection;
    transport: TinySetResult;
    report: Record<string, unknown>;
  };
}
const copy = (): ExportCopy => JSON.parse(genuineBytes.toString("utf8"));
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
function resign(value: ExportCopy) {
  value.original.observations_sha256 = sha256(
    JSON.stringify(value.provider_result.observations),
  );
}
function replay(value: unknown) {
  return buildRecordedInvestigation(bytes(value), "Saved security research");
}

test("genuine saved export replays without upgrading provider claims or starting research", () => {
  const saved = copy();
  const result = buildRecordedInvestigation(
    genuineBytes,
    "  Saved security research  ",
  );
  assert.equal(result.id, saved.id);
  assert.equal(result.label, "Saved security research");
  assert.equal(result.export_base, `/api/investigation/${saved.id}`);
  assert.equal(result.result_origin, "recorded_live");
  assert.equal(result.collection_mode, "saved_live");
  assert.equal(result.mode, "saved_live_review_pending");
  assert.equal(result.submission_ready, false);
  assert.equal(result.fresh_research_enabled, false);
  assert.equal(result.coverage.returned_by_tinyset, 19);
  assert.equal(result.coverage.independently_reviewed_recent, 0);
  assert.equal(
    result.rows.every((row) => row.source_status === "not_reviewed"),
    true,
  );
  assert.deepEqual(result.approach_ready_investors, []);
  assert.deepEqual(
    result.provider_result.observations,
    saved.provider_result.observations,
  );
  assert.deepEqual(
    result.provider_result.transport,
    saved.provider_result.transport,
  );
  assert.deepEqual(
    result.provider_result.report,
    rankRecentCompanies(saved.description, saved.provider_result.observations),
  );
  assert.equal(
    result.recording.source_export_sha256,
    "44574976e06ce99745037d6983b396871ef3608cbbbe846701c8518e64c0ad61",
  );
  assert.equal(
    result.original.observations_sha256,
    saved.original.observations_sha256,
  );
  assert.equal(result.recording.collected_at, saved.original.collected_at);
});

test("replay rejects malformed, oversized or empty bytes and invalid labels", () => {
  for (const input of [
    Buffer.alloc(0),
    Buffer.from("not JSON"),
    Buffer.alloc(2 * 1024 * 1024 + 1),
  ])
    assert.throws(() => buildRecordedInvestigation(input, "Saved"), {
      code: "INVALID_RECORDING",
    });
  for (const label of ["", "   ", "x".repeat(201)])
    assert.throws(() => buildRecordedInvestigation(genuineBytes, label), {
      code: "INVALID_RECORDING",
    });
});

test("replay refuses synthetic observations and failed or uncertain transports", () => {
  const synthetic = copy();
  synthetic.provider_result.observations.mode = "synthetic_fixture";
  resign(synthetic);
  assert.throws(() => replay(synthetic), { code: "INVALID_RECORDING" });
  const syntheticEnvelope = copy();
  syntheticEnvelope.collection_mode = "synthetic_fixture";
  assert.throws(() => replay(syntheticEnvelope), { code: "INVALID_RECORDING" });
  const syntheticMode = copy();
  syntheticMode.mode = "synthetic_fixture_with_separate_source_review";
  assert.throws(() => replay(syntheticMode), { code: "INVALID_RECORDING" });
  for (const status of ["failed", "cancelled", "populating", "empty"]) {
    const changed = copy();
    changed.provider_result.transport.status =
      status as TinySetResult["status"];
    assert.throws(() => replay(changed), { code: "INVALID_RECORDING" });
  }
});

test("replay binds the exact serialized observations rather than trusting a copied digest", () => {
  const changed = copy();
  changed.provider_result.observations.rows[0]!.data.company_name =
    "Altered company";
  changed.provider_result.transport.rows[0]!.data.company_name =
    "Altered company";
  assert.throws(() => replay(changed), { code: "INVALID_RECORDING" });
  const badDigest = copy();
  badDigest.original.observations_sha256 = "f".repeat(64);
  assert.throws(() => replay(badDigest), { code: "INVALID_RECORDING" });
});

test("observation key order remains intact for hash-bound replay", () => {
  const changed = copy();
  const observation = changed.provider_result.observations;
  changed.provider_result.observations = {
    rows: observation.rows,
    lookback_months: observation.lookback_months,
    as_of: observation.as_of,
    collected_at: observation.collected_at,
    run_id: observation.run_id,
    dataset_id: observation.dataset_id,
    mode: observation.mode,
    format: observation.format,
  };
  resign(changed);
  const result = replay(changed);
  assert.equal(
    JSON.stringify(result.provider_result.observations),
    JSON.stringify(changed.provider_result.observations),
  );
  assert.equal(
    result.original.observations_sha256,
    changed.original.observations_sha256,
  );
});

test("corrupt export, dataset and run identities are refused", () => {
  const malformed = copy();
  malformed.id = "not-a-request-id";
  assert.throws(() => replay(malformed), { code: "INVALID_RECORDING" });
  for (const target of ["original", "transport"] as const) {
    for (const key of ["dataset_id", "run_id"] as const) {
      const changed = copy();
      const record =
        target === "original"
          ? changed.original
          : changed.provider_result.transport;
      record[key] = "10000000-0000-4000-8000-000000000001";
      assert.throws(() => replay(changed), { code: "INVALID_RECORDING" });
    }
  }
});

test("replay checks target bounds and exact row counts", () => {
  for (const target of [9, 18, 21]) {
    const changed = copy();
    changed.provider_result.transport.target_rows = target;
    assert.throws(() => replay(changed), { code: "INVALID_RECORDING" });
  }
  const count = copy();
  count.provider_result.transport.row_count = 18;
  assert.throws(() => replay(count), { code: "INVALID_RECORDING" });
  const missing = copy();
  missing.provider_result.transport.rows.pop();
  assert.throws(() => replay(missing), { code: "INVALID_RECORDING" });
});

test("duplicate, reordered or modified transport rows cannot borrow original observations", () => {
  const duplicate = copy();
  duplicate.provider_result.transport.rows[1]!.id =
    duplicate.provider_result.transport.rows[0]!.id;
  assert.throws(() => replay(duplicate), { code: "INVALID_RECORDING" });
  const reordered = copy();
  reordered.provider_result.transport.rows.reverse();
  assert.throws(() => replay(reordered), { code: "INVALID_RECORDING" });
  const modified = copy();
  modified.provider_result.transport.rows[0]!.data.round_amount = 999;
  assert.throws(() => replay(modified), { code: "INVALID_RECORDING" });
  const duplicateObservations = copy();
  duplicateObservations.provider_result.observations.rows[1]!._id =
    duplicateObservations.provider_result.observations.rows[0]!._id;
  duplicateObservations.provider_result.transport.rows[1]!.id =
    duplicateObservations.provider_result.transport.rows[0]!.id;
  resign(duplicateObservations);
  assert.throws(() => replay(duplicateObservations), {
    code: "INVALID_OBSERVATIONS",
  });
});

test("future or inconsistent collection metadata cannot establish a recorded result", () => {
  const originalTime = copy();
  originalTime.original.collected_at = "2026-11-11T00:00:00Z";
  assert.throws(() => replay(originalTime), { code: "INVALID_RECORDING" });
  const transportTime = copy();
  transportTime.provider_result.transport.checked_at = "2026-11-11T00:00:00Z";
  assert.throws(() => replay(transportTime), { code: "INVALID_RECORDING" });
  const future = copy();
  future.original.collected_at = "2099-01-01T12:00:00.000Z";
  future.provider_result.transport.checked_at = future.original.collected_at;
  future.provider_result.observations.collected_at =
    future.original.collected_at;
  future.provider_result.observations.as_of = "2099-01-01";
  resign(future);
  assert.throws(() => replay(future), { code: "INVALID_OBSERVATIONS" });
  const mismatchedDay = copy();
  mismatchedDay.provider_result.observations.as_of = "2026-10-01";
  resign(mismatchedDay);
  assert.throws(() => replay(mismatchedDay), { code: "INVALID_OBSERVATIONS" });
});

test("unknown envelope fields, headers, old reports and forged review claims are never returned", () => {
  const changed = copy();
  const poisoned = {
    ...changed,
    secret_key: "never-expose-top-level",
    submission_ready: true,
    approach_ready_investors: [{ secret: "never-expose-false-shortlist" }],
    review: { secret: "never-expose-embedded-review" },
    provider_result: {
      ...changed.provider_result,
      headers: { Authorization: "never-expose-provider-headers" },
      report: { secret: "never-expose-raw-report" },
      transport: {
        ...changed.provider_result.transport,
        headers: { Authorization: "never-expose-transport-headers" },
        rows: changed.provider_result.transport.rows.map((row) => ({
          ...row,
          headers: "never-expose-row-headers",
        })),
      },
    },
  };
  const result = replay(poisoned);
  assert.doesNotMatch(JSON.stringify(result), /never-expose/);
  assert.deepEqual(Object.keys(result.provider_result).sort(), [
    "observations",
    "report",
    "transport",
  ]);
  assert.equal(result.review, null);
  assert.equal(result.submission_ready, false);
  assert.equal(
    result.provider_result.report.format,
    "funding-radar-recent-report-v2",
  );
});

test("a separately supplied genuine review binds its hash and preserves both evidence layers", () => {
  const result = buildRecordedInvestigation(
    genuineBytes,
    "Saved and reviewed",
    genuineReview,
  );
  assert.equal(result.coverage.returned_by_tinyset, 19);
  assert.equal(result.coverage.independently_reviewed_recent, 17);
  assert.equal(result.coverage.contradicted_or_excluded, 2);
  assert.equal(result.review!.case_id, 4);
  assert.equal(result.review!.scope, genuineReview.scope);
  assert.equal(result.mode, "saved_live_with_separate_source_review");
  assert.deepEqual(result.approach_ready_investors, []);
  assert.deepEqual(
    result.provider_result.observations,
    copy().provider_result.observations,
  );
  assert.equal(
    result.original.observations_sha256,
    genuineReview.original_observations_sha256,
  );
  assert.equal(result.rows[0]!.original_claim.company_name, "TrustCloud");
  assert.equal(result.rows[0]!.source_status, "verified_recent");
  assert.equal(
    result.investor_candidates.every(
      (candidate) => candidate.approach_ready === false,
    ),
    true,
  );
  const stale = structuredClone(genuineReview);
  stale.original_observations_sha256 = "a".repeat(64);
  assert.throws(
    () => buildRecordedInvestigation(genuineBytes, "Wrong review", stale),
    { code: "REVIEW_IDENTITY_MISMATCH" },
  );
});

test("review time and identity errors fail without leaking malformed review values", () => {
  const earlier = structuredClone(genuineReview);
  earlier.checked_at = "2026-01-01T00:00:00Z";
  assert.throws(
    () => buildRecordedInvestigation(genuineBytes, "Earlier review", earlier),
    { code: "REVIEW_TIME_INVALID" },
  );
  const future = structuredClone(genuineReview);
  future.checked_at = "2099-01-01T00:00:00Z";
  assert.throws(
    () => buildRecordedInvestigation(genuineBytes, "Future review", future),
    { code: "REVIEW_TIME_INVALID" },
  );
  assert.throws(
    () =>
      buildRecordedInvestigation(genuineBytes, "Invalid review", {
        secret: "never-expose-review-value",
      }),
    (error: unknown) =>
      error instanceof Error &&
      !error.message.includes("never-expose-review-value"),
  );
});

function unitRanking() {
  const saved = copy();
  const reviewed = buildReviewedCase(
    saved.description,
    bytes(saved.provider_result.observations),
    genuineReview,
  );
  const company = reviewed.rows.find(
    (row) => row.source_status === "verified_recent",
  )!;
  const sourceUrl = company.review!.sources[0]!.url;
  // Synthetic ranking contract only; this is never presented as real investor
  // evidence and does not modify the genuine company review or saved export.
  return {
    format: "funding-radar-reviewed-ranking-v1",
    checked_at: genuineReview.checked_at,
    research_snapshot_sha256: researchSnapshotDigest(reviewed),
    scope:
      "Synthetic unit-test ranking layer, solely to exercise hash-bound replay and preserved review scopes.",
    provider_operations_started: 0,
    investors: [
      {
        investor_name: "Synthetic Unit Ventures",
        investor_url: "https://unit-venture.example/",
        typical_cheque: {
          minimum: 100000,
          maximum: 1000000,
          currency: "USD",
          scope: "Synthetic unit-test policy, not a real investor cheque.",
          summary:
            "This range only exercises the separately sourced ranking contract.",
          source_urls: ["https://unit-venture.example/policy"],
        },
        stage_focus: {
          values: ["seed"],
          summary:
            "Synthetic test stage policy includes seed software investments.",
          source_urls: ["https://unit-venture.example/policy"],
        },
        geography_focus: {
          values: ["us"],
          summary:
            "Synthetic test geography policy includes United States startups.",
          source_urls: ["https://unit-venture.example/policy"],
        },
        geography_fit: "supported",
        geography_fit_note:
          "Synthetic contract value, not independently researched investor fit.",
        similar_companies: [
          {
            company_row_id: company.row_id,
            company_country: "us",
            product_fit: "direct",
            fit_summary:
              "Synthetic ranking fixture uses the already reviewed company's evidence identity.",
            investment_source_urls: [sourceUrl],
            lead: {
              name: "Synthetic Test Person",
              title: "Partner",
              role: "Synthetic named transaction responsibility for a pure contract test.",
              attribution: "explicit_personal_lead",
              summary:
                "Synthetic attribution only, not a real investment leadership claim.",
              qualification:
                "No real partner responsibility is asserted by this unit test.",
              current_status:
                "Synthetic test assumes the individual remains at the same firm.",
              team_continuity: "same_firm",
              source_urls: ["https://unit-venture.example/team"],
            },
          },
        ],
        contact_route: {
          url: "https://unit-venture.example/pitch",
          email: null,
          type: "founder_form",
          summary:
            "Synthetic founder form exists only to exercise the ranking schema.",
          source_urls: ["https://unit-venture.example/pitch"],
        },
        cautions: [
          "Synthetic unit-test profile, not genuine investor research.",
        ],
      },
    ],
  };
}

test("optional investor review is ranked after source review with separate scopes and fixed provenance", () => {
  const ranking = unitRanking();
  const result = buildRecordedInvestigation(
    genuineBytes,
    "Unit ranking replay",
    genuineReview,
    ranking,
  );
  assert.equal(result.review!.scope, genuineReview.scope);
  assert.equal(result.reviewed_shortlist!.scope, ranking.scope);
  assert.equal(
    result.reviewed_shortlist!.research_snapshot_sha256,
    ranking.research_snapshot_sha256,
  );
  assert.equal(result.approach_ready_investors.length, 1);
  assert.equal(
    result.approach_ready_investors[0]!.investor_name,
    "Synthetic Unit Ventures",
  );
  assert.equal(result.result_origin, "recorded_live");
  assert.equal(result.recording.source_export_sha256, sha256(genuineBytes));
  assert.equal(result.submission_ready, false);
  assert.throws(
    () =>
      buildRecordedInvestigation(
        genuineBytes,
        "No company review",
        undefined,
        ranking,
      ),
    { code: "RANKING_IDENTITY_MISMATCH" },
  );
  assert.throws(
    () =>
      buildRecordedInvestigation(
        genuineBytes,
        "Wrong rank digest",
        genuineReview,
        { ...ranking, research_snapshot_sha256: "b".repeat(64) },
      ),
    { code: "RANKING_IDENTITY_MISMATCH" },
  );
});
