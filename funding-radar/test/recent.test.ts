import test from "node:test";
import assert from "node:assert/strict";
import {
  planRecentFunding,
  rankRecentCompanies,
  recentWindow,
  fundingDateMentioned,
  fundingPeriod,
  type RecentCollection,
} from "../src/recent.js";
import { TinySetSpecSchema } from "../../providers/tinyset.js";
const startup =
  "UK pre-seed climate software startup building solar forecasting for energy operators";
function fixture(): RecentCollection {
  return {
    format: "funding-radar-rounds-v2",
    mode: "synthetic_fixture",
    dataset_id: "828b8ed4-c05f-442b-827d-95e930382b32",
    run_id: "cfb574ae-a91a-462d-b6b1-dc362d1809fa",
    collected_at: "2026-11-08T07:30:00.000Z",
    as_of: "2026-11-08",
    lookback_months: 18,
    rows: Array.from({ length: 10 }, (_, i) => ({
      _id: "synthetic-" + i,
      data: {
        company_round_key: `company${i}.example.com/2026-10-01`,
        company_name: `Synthetic company ${i}`,
        company_url: `https://company${i}.example.com`,
        announced_on: "2026-10-01",
        round_stage: "pre-seed",
        sector: "climate software",
        investor_name: `Synthetic fund ${i}`,
        investor_url: `https://fund${i}.example.com`,
        evidence_url: `https://company${i}.example.com/funding`,
        evidence_summary: `Synthetic company ${i} raised funding in a pre-seed round on 2026-10-01 led by Synthetic fund ${i} for its UK climate software platform.`,
      },
    })),
  };
}
test("current brief plans at least10 recent comparable companies with round keys and required unknown-capable investor fields", () => {
  const plan = planRecentFunding(startup, { asOf: "2026-11-08" });
  assert.equal(plan.body.target_rows, 10);
  assert.equal(plan.body.populate, false);
  assert.equal(plan.minimum_cost_microusd, 1000000);
  assert.equal(plan.window.since, "2025-05-08");
  assert.equal(TinySetSpecSchema.safeParse(plan.body.spec).success, true);
  assert.ok(
    ["cheque_min", "cheque_max", "lead_partner", "contact_route"].every(
      (name) => plan.body.spec.columns.some((c) => c.name === name),
    ),
  );
  assert.equal(
    plan.body.spec.columns.find((c) => c.is_primary_key)?.name,
    "company_round_key",
  );
  assert.throws(() => planRecentFunding(startup, { targetRows: 5 }));
  assert.deepEqual(recentWindow("2026-08-31", 18), {
    as_of: "2026-08-31",
    since: "2025-02-28",
    months: 18,
  });
});
test("ten distinct recent similar companies qualify without inventing unavailable cheque, partner or contact fields", () => {
  const report = rankRecentCompanies(startup, fixture());
  assert.equal(report.coverage.complete, true);
  assert.equal(report.coverage.distinct_recent_similar_companies, 10);
  assert.ok(
    report.rows.every(
      (r) =>
        r.cheque === null &&
        r.lead_partner === null &&
        r.contact_route === null,
    ),
  );
  assert.ok(
    report.rows.every((r) => r.unknowns.some((s) => s.includes("cheque"))),
  );
  assert.ok(
    report.rows.every((r) => r.evidence?.provenance === "provider_reported"),
  );
  const different = rankRecentCompanies(
    "US seed health startup building clinical diagnostics",
    fixture(),
  );
  assert.equal(different.coverage.distinct_recent_similar_companies, 0);
});
test("stale, future, impossible and uncorroborated dates do not satisfy the ten-company requirement", () => {
  for (const date of ["2025-05-07", "2026-11-09", "2026-02-31", "2026-10-02"]) {
    const input = fixture();
    input.rows[0]!.data.announced_on = date;
    if (date !== "2026-10-02")
      input.rows[0]!.data.evidence_summary = String(
        input.rows[0]!.data.evidence_summary,
      ).replace("2026-10-01", date);
    const report = rankRecentCompanies(startup, input);
    assert.equal(report.coverage.complete, false);
    assert.equal(report.coverage.shortfall, 1);
    assert.equal(report.rows[0]!.announced_on, null);
  }
  const boundary = fixture();
  boundary.rows[0]!.data.announced_on = "2025-05-08";
  boundary.rows[0]!.data.evidence_summary = String(
    boundary.rows[0]!.data.evidence_summary,
  ).replace("2026-10-01", "2025-05-08");
  assert.equal(rankRecentCompanies(startup, boundary).coverage.complete, true);
});
test("duplicate companies, unsafe links and fundraising intentions cannot inflate coverage", () => {
  const duplicate = fixture();
  duplicate.rows[1]!.data.company_url = duplicate.rows[0]!.data.company_url;
  assert.equal(
    rankRecentCompanies(startup, duplicate).coverage
      .distinct_recent_similar_companies,
    9,
  );
  for (const change of [
    { evidence_url: "https://news.example.com/funding?api_key=secret" },
    {
      evidence_summary:
        "Synthetic company 0 plans to raise funding on 2026-10-01 for a UK climate software platform.",
    },
    { company_url: "https://localhost/private" },
  ]) {
    const input = fixture();
    Object.assign(input.rows[0]!.data, change);
    assert.equal(
      rankRecentCompanies(startup, input).coverage
        .distinct_recent_similar_companies,
      9,
    );
  }
});
test("ranked investors arise only from recent comparable companies and require separate cheque, partner and contact evidence", () => {
  const input = fixture();
  Object.assign(input.rows[0]!.data, {
    geography: "UK",
    cheque_min: 100000,
    cheque_max: 500000,
    cheque_currency: "GBP",
    cheque_source_url: "https://fund0.example.com/thesis",
    cheque_evidence:
      "Synthetic fund 0 writes initial cheques of 100000 to 500000 GBP.",
    lead_partner: "Alex Example",
    partner_source_url: "https://fund0.example.com/team",
    partner_evidence:
      "Alex Example, a partner at Synthetic fund 0, led the investment.",
    contact_route: "https://fund0.example.com/pitch",
    contact_source_url: "https://fund0.example.com/pitch",
    contact_evidence:
      "Synthetic fund 0 accepts founder pitches on this public page.",
  });
  const report = rankRecentCompanies(startup, input),
    row = report.rows[0]!;
  assert.equal(row.cheque?.minimum, 100000);
  assert.equal(row.lead_partner?.name, "Alex Example");
  assert.equal(row.contact_route?.url, "https://fund0.example.com/pitch");
  assert.equal(report.investors[0]!.investor_name, "Synthetic fund 0");
  assert.ok(report.investors[0]!.reasons.length);
  assert.equal(
    report.investors[0]!.source_verification,
    "provider_reported_unverified",
  );
  input.rows[0]!.data.cheque_source_url = "https://directory.example.com";
  assert.equal(rankRecentCompanies(startup, input).rows[0]!.cheque, null);
});

test("exact English dates normalize without inventing a day; explicit whole months retain their precision", () => {
  assert.equal(
    fundingDateMentioned("Announced on Apr 1, 2026.", "2026-04-01"),
    true,
  );
  assert.equal(
    fundingDateMentioned("Announced on 23 June 2025.", "2025-06-23"),
    true,
  );
  assert.equal(
    fundingDateMentioned("Announced on Apr 1, 2026.", "2026-04-02"),
    false,
  );
  assert.equal(
    fundingDateMentioned("Announced 2026-02-31.", "2026-02-31"),
    false,
  );
  const window = { since: "2025-05-08", as_of: "2026-11-08" };
  assert.deepEqual(
    fundingPeriod("Raised in June 2025.", "2025-06-24", undefined, window),
    {
      precision: "month",
      day: null,
      month: "2025-06",
      start: "2025-06-01",
      end: "2025-06-30",
    },
  );
  assert.equal(
    fundingPeriod("Raised in May 2025.", "2025-05-16", undefined, window),
    null,
  );
  assert.equal(
    fundingPeriod("Raised in November 2026.", "2026-11-01", undefined, window),
    null,
  );
  assert.equal(
    fundingPeriod("Raised on 2025-06-23.", "2025-06-24", undefined, window),
    null,
  );
});
test("dated news is permitted by the actual brief while provenance and exact-date gaps remain visible", () => {
  const data = fixture();
  data.rows[0]!.data.evidence_url = "https://news.example.com/funding";
  data.rows[0]!.data.evidence_summary =
    "Synthetic company 0 raised a pre-seed funding round in October 2026 led by Synthetic fund 0 for a UK climate software platform.";
  const row = rankRecentCompanies(startup, data).rows[0]!;
  assert.equal(row.qualifying_recent_company, true);
  assert.equal(row.announced_on, null);
  assert.equal(row.announced_month, "2026-10");
  assert.equal(row.announcement_precision, "month");
  assert.equal(row.evidence?.source_type, "third_party_reported");
  assert.ok(row.unknowns.some((s) => s.includes("Exact announcement day")));
});
