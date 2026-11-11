import { z } from "zod";
import { publicUrl } from "../../zombie-check/src/urls.js";
import { FundingError, type Startup } from "./core.js";
import { sha256 } from "./review.js";

const source = z.string().transform((value) => publicUrl(value));
const sources = z.array(source).min(1).max(10);
const summary = z.string().min(15).max(2000);
const focus = z
  .object({
    values: z.array(z.string().min(1).max(100)).max(30),
    summary,
    source_urls: sources,
  })
  .strict();
const lead = z
  .object({
    name: z.string().min(3).max(200),
    title: z.string().min(2).max(200),
    role: z.string().min(10).max(500),
    attribution: z.enum([
      "explicit_personal_lead",
      "transaction_participant_attribution",
      "first_person_with_transaction_corroboration",
    ]),
    summary,
    qualification: summary,
    current_status: z.string().min(10).max(1000),
    team_continuity: z.enum(["same_firm", "moved_firm", "unknown"]),
    source_urls: sources,
  })
  .strict();
const profile = z
  .object({
    investor_name: z.string().min(2).max(200),
    investor_url: source,
    typical_cheque: z
      .object({
        minimum: z.number().positive(),
        maximum: z.number().positive(),
        currency: z.string().regex(/^[A-Z]{3}$/),
        scope: z.string().min(15).max(1000),
        summary,
        source_urls: sources,
      })
      .strict()
      .refine((v) => v.maximum >= v.minimum, "Cheque range is reversed."),
    stage_focus: focus,
    geography_focus: focus,
    geography_fit: z.enum(["supported", "uncertain", "excluded"]),
    geography_fit_note: summary,
    similar_companies: z
      .array(
        z
          .object({
            company_row_id: z.string().min(1).max(200),
            company_country: z.string().min(2).max(100),
            product_fit: z.enum(["direct", "adjacent"]),
            fit_summary: summary,
            investment_source_urls: sources,
            lead,
          })
          .strict(),
      )
      .min(1)
      .max(20),
    contact_route: z
      .object({
        url: source,
        email: z.email().nullable(),
        type: z.enum([
          "founder_form",
          "investment_email",
          "open_intake",
          "warm_intro",
        ]),
        summary,
        source_urls: sources,
      })
      .strict(),
    fit_conditions: z
      .array(
        z
          .object({
            condition: z.string().min(10).max(500),
            status: z.enum(["supported", "unconfirmed", "excluded"]),
            detail: summary,
            source_urls: sources,
          })
          .strict(),
      )
      .max(10)
      .default([]),
    cautions: z.array(z.string().min(10).max(1500)).max(20),
  })
  .strict();
export const RankingReviewSchema = z
  .object({
    format: z.literal("funding-radar-reviewed-ranking-v1"),
    checked_at: z.iso.datetime({ offset: true }),
    research_snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    scope: z.string().min(30).max(3000),
    investors: z.array(profile).min(1).max(30),
    provider_operations_started: z.literal(0),
  })
  .strict();

export interface ResearchSnapshot {
  collection_mode: "saved_live" | "synthetic_fixture";
  description: string;
  startup: Startup;
  window: { since: string; as_of: string };
  original: { observations_sha256: string; collected_at: string };
  rows: Array<{
    row_id: string;
    company_name: string;
    company_url: string | null;
    round_stage: string | null;
    source_status: string;
    review: {
      announced_on: string | null;
      announced_month: string | null;
      sources: Array<{ url: string }>;
    } | null;
  }>;
}

/** Binds the review to the exact input and company evidence, not just a display case number. */
export function researchSnapshotDigest(data: ResearchSnapshot): string {
  return sha256(
    JSON.stringify({
      description: data.description,
      collection_mode: data.collection_mode,
      startup: data.startup,
      window: data.window,
      observations_sha256: data.original.observations_sha256,
      companies: data.rows.map((row) => ({
        row_id: row.row_id,
        company_name: row.company_name,
        company_url: row.company_url,
        round_stage: row.round_stage,
        source_status: row.source_status,
        review: row.review,
      })),
    }),
  );
}

/** A dated source review supplies facts; the same deterministic ranking works for any bound research snapshot. */
export function rankReviewedInvestors(data: ResearchSnapshot, value: unknown) {
  if (data.collection_mode !== "saved_live")
    throw new FundingError(
      "RANKING_PROVENANCE_INVALID",
      "Synthetic observations cannot establish a source-complete live-investment shortlist.",
    );
  const review = RankingReviewSchema.parse(value);
  if (review.research_snapshot_sha256 !== researchSnapshotDigest(data))
    throw new FundingError(
      "RANKING_IDENTITY_MISMATCH",
      "Investor review belongs to a different startup or evidence snapshot.",
    );
  if (
    Date.parse(review.checked_at) > Date.now() + 5000 ||
    Date.parse(review.checked_at) < Date.parse(data.original.collected_at)
  )
    throw new FundingError(
      "RANKING_TIME_INVALID",
      "Investor source review cannot be future-dated.",
    );
  const identities = new Set<string>();
  const investors = review.investors
    .map((investor) => {
      const identity = new URL(investor.investor_url).hostname.replace(
        /^www\./,
        "",
      );
      if (identities.has(identity))
        throw new FundingError(
          "RANKING_DUPLICATE",
          "An investor can appear only once in the reviewed shortlist.",
        );
      identities.add(identity);
      const rowIds = new Set<string>();
      const deals = investor.similar_companies.map((deal) => {
        const row = data.rows.find((r) => r.row_id === deal.company_row_id);
        if (
          !row ||
          row.source_status !== "verified_recent" ||
          !row.company_url ||
          !row.review ||
          rowIds.has(row.row_id)
        )
          throw new FundingError(
            "RANKING_DEAL_UNSUPPORTED",
            "Rank an investor only from distinct source-reviewed recent comparable companies.",
          );
        if (
          !deal.investment_source_urls.some((url) =>
            row.review!.sources.some((item) => item.url === url),
          )
        )
          throw new FundingError(
            "RANKING_DEAL_UNSUPPORTED",
            "Investment proof must connect to the reviewed company evidence, not an unrelated link.",
          );
        rowIds.add(row.row_id);
        return {
          ...deal,
          company_name: row.company_name,
          company_url: row.company_url,
          announced_on: row.review.announced_on,
          announced_month: row.review.announced_month,
          round_stage: row.round_stage,
        };
      });
      const stageMatches =
        !!data.startup.stage &&
        investor.stage_focus.values.some(
          (stage) =>
            stage.toLowerCase().replace(/\s+/g, "-") === data.startup.stage,
        );
      const score_breakdown: Array<{
        label: string;
        points: number;
        detail: string;
      }> = [];
      const add = (label: string, points: number, detail: string) =>
        score_breakdown.push({ label, points, detail });
      const direct = deals.some((d) => d.product_fit === "direct");
      add(
        "Product overlap",
        direct ? 35 : 20,
        direct
          ? "At least one reviewed investment has direct product/customer overlap."
          : "The supported comparable is adjacent; this receives less weight than direct overlap.",
      );
      add(
        "Current stage focus",
        stageMatches ? 20 : 0,
        stageMatches
          ? "Published investor stage focus includes the input startup stage."
          : "Published stage focus does not establish a match to the input stage.",
      );
      const countryAlias = (value: string) => {
        const name = value.toLowerCase().trim();
        return (
          (
            {
              "united states": "us",
              usa: "us",
              "united kingdom": "uk",
              britain: "uk",
            } as Record<string, string>
          )[name] ?? name
        );
      };
      const countryMatches =
        !!data.startup.geography &&
        deals.some(
          (d) => countryAlias(d.company_country) === data.startup.geography,
        );
      add(
        "Comparable country",
        countryMatches ? 10 : 0,
        countryMatches
          ? "A supported comparable operates in the startup's country."
          : "Comparable country differs or remains unclassified; no country points awarded.",
      );
      add(
        "Recent investment evidence",
        Math.min(15, deals.length * 5),
        `${deals.length} distinct reviewed recent investment(s), capped at 15 points.`,
      );
      add(
        "Named transaction responsibility",
        10,
        "Named investment responsibility has transaction-specific source support, with role and attribution limits preserved.",
      );
      add(
        "Typical cheque evidence",
        5,
        "A sourced typical range is supplied separately from the comparable's round total.",
      );
      add(
        "Founder contact route",
        5,
        "An explicit founder or investment intake route is supplied; no outreach was sent.",
      );
      if (deals.some((d) => d.lead.team_continuity === "moved_firm"))
        add(
          "Team continuity",
          -5,
          "A historical deal lead has moved firms; use the current firm route rather than assuming their availability there.",
        );
      if (investor.geography_fit === "uncertain")
        add("Geography policy uncertainty", -5, investor.geography_fit_note);
      if (investor.geography_fit === "excluded")
        add("Geography policy mismatch", -30, investor.geography_fit_note);
      const cautions = [...investor.cautions];
      if (!stageMatches)
        cautions.push(
          "The startup's stage is not established as a current investor fit.",
        );
      const unmetConditions = investor.fit_conditions.filter(
        (condition) => condition.status !== "supported",
      );
      if (unmetConditions.length)
        add(
          "Additional fit requirements",
          -Math.min(10, unmetConditions.length * 5),
          unmetConditions
            .map((condition) => condition.condition + ": " + condition.detail)
            .join(" "),
        );
      if (investor.geography_fit !== "supported")
        cautions.push(investor.geography_fit_note);
      cautions.push(
        ...unmetConditions.map(
          (condition) => condition.condition + ": " + condition.detail,
        ),
      );
      const approach_ready =
        stageMatches &&
        investor.geography_fit === "supported" &&
        unmetConditions.length === 0;
      return {
        ...investor,
        similar_companies: deals,
        score: Math.max(
          0,
          score_breakdown.reduce((sum, item) => sum + item.points, 0),
        ),
        score_breakdown,
        reasons: score_breakdown.map(
          (item) =>
            `${item.points >= 0 ? "+" : ""}${item.points}: ${item.label}. ${item.detail}`,
        ),
        cautions,
        evidence_complete: true as const,
        approach_ready,
      };
    })
    .sort(
      (a, b) =>
        Number(b.approach_ready) - Number(a.approach_ready) ||
        b.score - a.score ||
        a.investor_name.localeCompare(b.investor_name),
    );
  return {
    format: review.format,
    checked_at: review.checked_at,
    scope: review.scope,
    research_snapshot_sha256: review.research_snapshot_sha256,
    investors: investors.map((investor, i) => ({ ...investor, rank: i + 1 })),
    ranking_note:
      "Evidence completeness supports owner review and a sourced contact route. Historical investments, model scores and published policies do not promise current interest or funding. This is a selected shortlist, not an exhaustive list of every investor.",
  };
}
