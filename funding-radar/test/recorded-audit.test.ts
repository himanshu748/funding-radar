import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rankRecentCompanies, type RecentCollection } from "../src/recent.js";
import {
  attachRecordedAudit,
  parseRecordedAudit,
} from "../src/recorded-audit.js";

const description =
  "UK pre-seed climate software startup building solar forecasting";
function fixture() {
  const observations: RecentCollection = {
    format: "funding-radar-rounds-v2",
    mode: "synthetic_fixture",
    dataset_id: "8b71c234-437f-4a6c-9d25-0cb4f032aaff",
    run_id: "f6f7b29c-cf34-4588-ac80-00fbbac913e5",
    collected_at: "2026-11-08T07:30:00.000Z",
    as_of: "2026-11-08",
    lookback_months: 18,
    rows: [
      {
        _id: "example",
        data: {
          company_name: "Example Climate Labs",
          company_url: "https://labs.example.com/",
          investor_name: "Example Fund",
          investor_url: "https://fund.example.com/",
          announced_on: "2026-10-01",
          round_stage: "pre-seed",
          sector: "climate software",
          geography: "UK",
          evidence_url: "https://labs.example.com/funding",
          evidence_summary:
            "Example Climate Labs raised pre-seed funding from Example Fund on 2026-10-01 for its UK climate software platform.",
        },
      },
    ],
  };
  const text = String(observations.rows[0]!.data.evidence_summary),
    url = "https://www.labs.example.com/funding";
  const outcome = {
    url,
    index: 1,
    status: "fetched",
    observed_at: "2026-11-08T08:00:00.000Z",
    text_sha256: createHash("sha256").update(text).digest("hex"),
    metadata: [
      { name: "article:modified_time", value: "2026-11-01T00:00:00Z" },
      { name: "article:published_time", value: "2026-10-01T00:00:00Z" },
    ],
  };
  const audit = {
    kind: "funding-source-audit-v2",
    provider: "tinyfish-fetch",
    distinct_source_checks: 1,
    reservation_unit_price_microusd: 0,
    halted: false,
    outcomes: [outcome],
  };
  return {
    observations,
    text,
    url,
    outcome,
    audit,
    report: rankRecentCompanies(description, observations),
  };
}
test("saved source retrieval adds hash-checked text presence without becoming semantic verification", () => {
  const f = fixture(),
    r = attachRecordedAudit(
      f.report,
      f.observations,
      f.audit,
      new Map([[f.url, f.text]]),
    ),
    check = r.rows[0]!.source_corroboration;
  assert.equal(check.status, "text_retrieved");
  if (check.status !== "text_retrieved") throw new Error("missing check");
  assert.equal(check.semantic_verification, "not_established");
  assert.equal(check.url_match, "reviewed_www_or_trailing_slash_alias");
  assert.equal(check.text_checks?.supplied_exact_day_literal_present, true);
  assert.deepEqual(check.published_days, ["2026-10-01"]);
  assert.equal(r.source_audit.new_provider_operations, 0);
  assert.equal(
    r.investors[0]!.source_verification,
    "provider_reported_unverified",
  );
});
test("redirect-rejected and unchecked sources remain explicit gaps without altering eligibility claims", () => {
  const f = fixture();
  const audit = {
    ...f.audit,
    outcomes: [
      {
        url: f.url,
        index: 1,
        status: "not_corroborated",
        error: "REDIRECT_REJECTED",
      },
    ],
  };
  const r = attachRecordedAudit(f.report, f.observations, audit);
  assert.equal(r.rows[0]!.source_corroboration.status, "not_corroborated");
  assert.equal(
    r.rows[0]!.qualifying_recent_company,
    f.report.rows[0]!.qualifying_recent_company,
  );
  assert.equal(r.source_audit.rows_with_uncorroborated_source, 1);
  const absent = attachRecordedAudit(f.report, f.observations, {
    ...f.audit,
    distinct_source_checks: 0,
    outcomes: [],
  });
  assert.equal(absent.rows[0]!.source_corroboration.status, "not_checked");
});
test("duplicate source identities and altered saved body digests fail before a corroboration claim", () => {
  const f = fixture();
  assert.throws(() =>
    parseRecordedAudit({
      ...f.audit,
      distinct_source_checks: 2,
      outcomes: [f.outcome, { ...f.outcome, index: 2 }],
    }),
  );
  assert.throws(() =>
    attachRecordedAudit(
      f.report,
      f.observations,
      f.audit,
      new Map([[f.url, "different body"]]),
    ),
  );
});
