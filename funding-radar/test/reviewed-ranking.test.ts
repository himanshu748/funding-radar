import test from "node:test";
import assert from "node:assert/strict";
import { parseStartup } from "../src/core.js";
import {
  rankReviewedInvestors,
  researchSnapshotDigest,
  type ResearchSnapshot,
} from "../src/reviewed-ranking.js";

function fixture() {
  const data: ResearchSnapshot = {
    collection_mode: "saved_live", // Unit fixture modeling this contract; not execution evidence.
    description:
      "US seed software startup automating microscope image analysis for labs",
    startup: parseStartup(
      "US seed software startup automating microscope image analysis for labs",
    ),
    window: { since: "2025-05-08", as_of: "2026-11-08" },
    original: {
      observations_sha256: "a".repeat(64),
      collected_at: "2026-11-08T08:00:00Z",
    },
    rows: [
      {
        row_id: "row-a",
        company_name: "Synthetic Microscopy",
        company_url: "https://microscopy.example/",
        round_stage: "Seed",
        source_status: "verified_recent",
        review: {
          announced_on: "2026-04-01",
          announced_month: null,
          sources: [{ url: "https://microscopy.example/seed" }],
        },
      },
    ],
  };
  const investor = {
    investor_name: "Synthetic Ventures",
    investor_url: "https://venture.example/",
    typical_cheque: {
      minimum: 500000,
      maximum: 2000000,
      currency: "USD",
      scope: "Published initial cheque range, not the comparable round total.",
      summary: "Synthetic firm policy states its usual initial cheque range.",
      source_urls: ["https://venture.example/policy"],
    },
    stage_focus: {
      values: ["seed"],
      summary:
        "The published stage focus includes seed-stage software companies.",
      source_urls: ["https://venture.example/policy"],
    },
    geography_focus: {
      values: ["us"],
      summary: "The firm publishes a United States investment focus.",
      source_urls: ["https://venture.example/policy"],
    },
    geography_fit: "supported",
    geography_fit_note:
      "The source supports the startup's geography; this is not a funding promise.",
    similar_companies: [
      {
        company_row_id: "row-a",
        company_country: "us",
        product_fit: "direct",
        fit_summary:
          "Both products automate the same scientific image-analysis task.",
        investment_source_urls: ["https://microscopy.example/seed"],
        lead: {
          name: "Synthetic Person",
          title: "Principal",
          role: "The named lead for the firm's investment, not a claim of sole negotiation.",
          attribution: "transaction_participant_attribution",
          summary:
            "The transaction participant expressly identifies the responsible investor.",
          qualification:
            "The individual title is Principal; the source does not claim sole negotiating responsibility.",
          current_status:
            "Still associated with the firm according to its current team page.",
          team_continuity: "same_firm",
          source_urls: [
            "https://microscopy.example/seed",
            "https://venture.example/team",
          ],
        },
      },
    ],
    contact_route: {
      url: "https://venture.example/pitch",
      email: null,
      type: "founder_form",
      summary:
        "The official site explicitly invites founders to submit a fundraising brief.",
      source_urls: ["https://venture.example/pitch"],
    },
    cautions: [
      "This is a synthetic test record, not real investment evidence.",
    ],
  };
  return {
    data,
    review: {
      format: "funding-radar-reviewed-ranking-v1",
      checked_at: "2026-11-11T06:00:00Z",
      research_snapshot_sha256: researchSnapshotDigest(data),
      scope:
        "Synthetic unit-test source review; no provider execution or real investor claim.",
      investors: [investor],
      provider_operations_started: 0,
    },
  };
}
test("a bound review generates a sourced ranking for an arbitrary startup without granting funding certainty", () => {
  const { data, review } = fixture();
  const ranked = rankReviewedInvestors(data, review);
  assert.equal(ranked.investors[0]!.rank, 1);
  assert.equal(ranked.investors[0]!.score, 90);
  assert.equal(ranked.investors[0]!.approach_ready, true);
  assert.equal(
    ranked.investors[0]!.similar_companies[0]!.lead.title,
    "Principal",
  );
  assert.match(ranked.ranking_note, /do not promise/);
});
test("different descriptions or changed company evidence cannot borrow a reviewed investor list", () => {
  const { data, review } = fixture();
  for (const changed of [
    { ...data, description: "India Series A fintech for retailers" },
    {
      ...data,
      rows: data.rows.map((r) => ({ ...r, company_name: "Different company" })),
    },
    { ...data, startup: { ...data.startup, stage: "growth" as const } },
  ])
    assert.throws(() => rankReviewedInvestors(changed, review), {
      code: "RANKING_IDENTITY_MISMATCH",
    });
});

test("synthetic observations cannot be promoted into a live reviewed investor shortlist", () => {
  const { data, review } = fixture();
  assert.throws(
    () =>
      rankReviewedInvestors(
        { ...data, collection_mode: "synthetic_fixture" },
        review,
      ),
    { code: "RANKING_PROVENANCE_INVALID" },
  );
});

test("human-readable stage and country aliases preserve the actual fit", () => {
  const { data, review } = fixture();
  review.investors[0]!.stage_focus.values = ["Pre-seed", "Seed", "Series A"];
  review.investors[0]!.similar_companies[0]!.company_country = "United States";
  const result = rankReviewedInvestors(data, review).investors[0]!;
  assert.equal(result.approach_ready, true);
  assert.equal(result.score, 90);
});

test("unconfirmed program-specific requirements remain a conditional watchlist record", () => {
  const { data, review } = fixture();
  const investor = {
    ...review.investors[0]!,
    fit_conditions: [
      {
        condition: "The startup must meet the AI programme scope",
        status: "unconfirmed",
        detail:
          "The input does not establish this programme-specific eligibility requirement.",
        source_urls: ["https://venture.example/programme"],
      },
    ],
  };
  const result = rankReviewedInvestors(data, {
    ...review,
    investors: [investor],
  }).investors[0]!;
  assert.equal(result.evidence_complete, true);
  assert.equal(result.approach_ready, false);
  assert.ok(
    result.cautions.some((note) => note.includes("programme-specific")),
  );
  assert.equal(result.score, 85);
});
test("excluded, duplicated, missing or unrelated investment evidence cannot gain ranking points", () => {
  const { data, review } = fixture();
  const excluded = {
    ...data,
    rows: data.rows.map((r) => ({ ...r, source_status: "out_of_window" })),
  };
  assert.throws(
    () =>
      rankReviewedInvestors(excluded, {
        ...review,
        research_snapshot_sha256: researchSnapshotDigest(excluded),
      }),
    { code: "RANKING_DEAL_UNSUPPORTED" },
  );
  const duplicate = structuredClone(review);
  duplicate.investors[0]!.similar_companies.push(
    duplicate.investors[0]!.similar_companies[0]!,
  );
  assert.throws(() => rankReviewedInvestors(data, duplicate), {
    code: "RANKING_DEAL_UNSUPPORTED",
  });
  const unrelated = structuredClone(review);
  unrelated.investors[0]!.similar_companies[0]!.investment_source_urls = [
    "https://unrelated.example/portfolio",
  ];
  assert.throws(() => rankReviewedInvestors(data, unrelated), {
    code: "RANKING_DEAL_UNSUPPORTED",
  });
});
test("ranges, source sets, lead attribution and unexpected score overrides fail closed", () => {
  const { data, review } = fixture();
  const bad: unknown[] = [];
  const range = structuredClone(review);
  range.investors[0]!.typical_cheque.maximum = 1;
  bad.push(range);
  const missing = structuredClone(review);
  missing.investors[0]!.contact_route.source_urls = [];
  bad.push(missing);
  const guessed = structuredClone(review) as any;
  guessed.investors[0].similar_companies[0].lead.attribution = "quote_only";
  bad.push(guessed);
  const override = structuredClone(review) as any;
  override.investors[0].score = 999;
  bad.push(override);
  const privateSource = structuredClone(review);
  privateSource.investors[0]!.typical_cheque.source_urls = [
    "http://127.0.0.1/private",
  ];
  bad.push(privateSource);
  for (const value of bad)
    assert.throws(() => rankReviewedInvestors(data, value));
});
test("current stage, geography, adjacent products and moved partners affect rank without erasing historical roles", () => {
  const { data, review } = fixture();
  const conditional = structuredClone(review.investors[0]!);
  conditional.investor_name = "Conditional Ventures";
  conditional.investor_url = "https://conditional.example/";
  conditional.stage_focus.values = ["growth"];
  conditional.geography_fit = "excluded";
  conditional.similar_companies[0]!.product_fit = "adjacent";
  conditional.similar_companies[0]!.lead.team_continuity = "moved_firm";
  const ranked = rankReviewedInvestors(data, {
    ...review,
    investors: [conditional, ...review.investors],
  });
  assert.equal(ranked.investors[0]!.investor_name, "Synthetic Ventures");
  assert.equal(ranked.investors[1]!.approach_ready, false);
  assert.ok(ranked.investors[1]!.score < ranked.investors[0]!.score);
  assert.equal(
    ranked.investors[1]!.similar_companies[0]!.lead.name,
    "Synthetic Person",
  );
  assert.ok(
    ranked.investors[1]!.score_breakdown.some(
      (r) => r.label === "Team continuity" && r.points < 0,
    ),
  );
});
test("future or pre-collection reviews and duplicate www investor aliases are rejected", () => {
  const { data, review } = fixture();
  for (const checked_at of ["2099-01-01T00:00:00Z", "2026-01-01T00:00:00Z"])
    assert.throws(
      () => rankReviewedInvestors(data, { ...review, checked_at }),
      { code: "RANKING_TIME_INVALID" },
    );
  const alias = structuredClone(review.investors[0]!);
  alias.investor_url = "https://www.venture.example/";
  assert.throws(
    () =>
      rankReviewedInvestors(data, {
        ...review,
        investors: [...review.investors, alias],
      }),
    { code: "RANKING_DUPLICATE" },
  );
});
