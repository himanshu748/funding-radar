import { z } from "zod";
import { createHash } from "node:crypto";
import { parseRecentObservations, rankRecentCompanies } from "./recent.js";
import { FundingError } from "./core.js";
import { publicUrl } from "../../zombie-check/src/urls.js";

const sourceUrl = z.string().transform((value, context) => {
  try {
    return publicUrl(value);
  } catch {
    context.addIssue({
      code: "custom",
      message: "Use a public HTTPS source URL.",
    });
    return z.NEVER;
  }
});
const evidence = z.object({
  url: sourceUrl,
  kind: z.enum([
    "company",
    "investor",
    "transaction_participant",
    "news",
    "other",
  ]),
  supports: z
    .array(
      z.enum([
        "identity",
        "completed_round",
        "date",
        "fit",
        "investor",
        "stage",
        "amount",
        "partner",
        "contact",
        "cheque",
      ]),
    )
    .min(1)
    .max(10),
  note: z.string().min(10).max(1500),
});
const rowReview = z
  .object({
    row_id: z.string().min(1).max(200),
    company_name: z.string().min(1).max(200),
    decision: z.enum([
      "verified_recent",
      "out_of_window",
      "not_comparable",
      "unresolved",
    ]),
    announced_on: z.iso.date().nullable(),
    announced_month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .nullable(),
    notes: z.array(z.string().min(5).max(1500)).min(1).max(20),
    sources: z.array(evidence).max(20),
    withheld_fields: z.array(z.string().max(100)).max(20),
  })
  .superRefine((row, context) => {
    if (row.decision !== "verified_recent") return;
    const supported = new Set(row.sources.flatMap((s) => s.supports));
    if (
      !["identity", "completed_round", "date", "fit"].every((s) =>
        supported.has(s as never),
      ) ||
      (!row.announced_on && !row.announced_month)
    )
      context.addIssue({
        code: "custom",
        message:
          "Verified recent companies need identity, completed round, precise period and fit evidence.",
      });
  });
export const CaseReviewSchema = z.object({
  format: z.literal("funding-radar-source-review-v1"),
  case_id: z.number().int().min(1).max(1_000_000),
  checked_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }).optional(),
  method: z.literal("ordinary_web_primary_source_review"),
  original_observations_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.string().min(20).max(2000),
  rows: z.array(rowReview).max(50),
  investors: z
    .array(
      z.object({
        name: z.string().min(2).max(200),
        facts: z
          .array(
            z.object({
              field: z.enum([
                "typical_cheque",
                "stage",
                "deal_partner",
                "contact",
              ]),
              status: z.enum([
                "supported",
                "limited",
                "unknown",
                "contradicted",
              ]),
              value: z.string().min(1).max(1500).nullable(),
              source_urls: z.array(sourceUrl).max(10),
              note: z.string().min(5).max(1500),
            }),
          )
          .max(12),
      }),
    )
    .max(50)
    .default([]),
  blockers: z.array(z.string().min(5).max(1500)).max(30),
  provider_operations_started: z.literal(0),
});
export type CaseReview = z.infer<typeof CaseReviewSchema>;
export const sha256 = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/** AI-assisted source review is a dated evidence layer. It never rewrites or upgrades the original TinySet receipt. */
export function buildReviewedCase(
  description: string,
  originalBytes: Buffer,
  reviewValue?: unknown,
  expectedCaseId?: number,
) {
  const observations = parseRecentObservations(
    JSON.parse(originalBytes.toString("utf8")),
  );
  const report = rankRecentCompanies(description, observations);
  const review =
    reviewValue === undefined ? null : CaseReviewSchema.parse(reviewValue);
  if (
    review &&
    expectedCaseId !== undefined &&
    review.case_id !== expectedCaseId
  )
    throw new FundingError(
      "REVIEW_IDENTITY_MISMATCH",
      "Review case ID differs from the selected investigation.",
    );
  if (review && review.original_observations_sha256 !== sha256(originalBytes))
    throw new FundingError(
      "REVIEW_IDENTITY_MISMATCH",
      "Review does not belong to these original observations.",
    );
  if (
    review &&
    (Date.parse(review.checked_at) > Date.now() + 5000 ||
      Date.parse(review.checked_at) < Date.parse(observations.collected_at))
  )
    throw new FundingError(
      "REVIEW_TIME_INVALID",
      "Future review dates cannot establish source verification.",
    );
  if (
    review?.updated_at &&
    (Date.parse(review.updated_at) < Date.parse(review.checked_at) ||
      Date.parse(review.updated_at) > Date.now() + 5000)
  )
    throw new FundingError(
      "REVIEW_TIME_INVALID",
      "Updated review time must follow the original review and cannot be future-dated.",
    );
  const ids = new Set(observations.rows.map((r) => r._id));
  if (
    review &&
    (new Set(review.rows.map((r) => r.row_id)).size !== review.rows.length ||
      review.rows.some((r) => !ids.has(r.row_id)))
  )
    throw new FundingError(
      "REVIEW_IDENTITY_MISMATCH",
      "Review row identities must be unique and present in the original run.",
    );
  const records = new Map(review?.rows.map((r) => [r.row_id, r]) ?? []);
  for (const row of review?.rows ?? []) {
    const original = report.rows.find((r) => r.row_id === row.row_id)!;
    if (original.company_name.toLowerCase() !== row.company_name.toLowerCase())
      throw new FundingError(
        "REVIEW_IDENTITY_MISMATCH",
        "Review company identity differs from its source row.",
      );
    if (
      row.announced_on &&
      row.announced_month &&
      !row.announced_on.startsWith(row.announced_month + "-")
    )
      throw new FundingError(
        "REVIEW_WINDOW_MISMATCH",
        "Reviewed day and month disagree.",
      );
    if (row.decision !== "verified_recent") continue;
    const start = row.announced_on ?? row.announced_month + "-01";
    const [year, month] = (row.announced_month ?? row.announced_on!.slice(0, 7))
      .split("-")
      .map(Number);
    const end =
      row.announced_on ??
      new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10);
    if (start < report.window.since || end > report.window.as_of)
      throw new FundingError(
        "REVIEW_WINDOW_MISMATCH",
        "A reviewed company period is outside this historical research window.",
      );
  }
  const rows = report.rows.map((row) => ({
    ...row,
    round_stage: records
      .get(row.row_id)
      ?.withheld_fields.includes("round_stage")
      ? null
      : row.round_stage,
    original_claim: observations.rows.find((r) => r._id === row.row_id)!.data,
    // Candidate scores/facts remain separate from the source review. Suppressed claims cannot regain rank via the original report.
    review: records.get(row.row_id) ?? null,
    source_status: records.get(row.row_id)?.decision ?? "not_reviewed",
    review_required: true,
  }));
  const verified = new Set(
    rows
      .filter((r) => r.source_status === "verified_recent")
      .map((r) => r.company_url),
  );
  const excluded = new Set(
    rows
      .filter((r) =>
        ["out_of_window", "not_comparable"].includes(r.source_status),
      )
      .map((r) => r.row_id),
  );
  // Re-run the candidate heuristic on retained rows. Excluded deals cannot contribute
  // evidence, score, stages or contacts to an investor who also has a retained deal.
  // Provider-only enrichment is withheld; independently reviewed details live in review.investors.
  const retained = {
    ...observations,
    rows: observations.rows
      .filter((row) => !excluded.has(row._id))
      .map((row) => ({
        ...row,
        data: {
          ...row.data,
          ...(records.get(row._id)?.withheld_fields.includes("round_stage")
            ? { round_stage: null }
            : {}),
          cheque_min: null,
          cheque_max: null,
          lead_partner: null,
          contact_route: null,
        },
      })),
  };
  const candidates = rankRecentCompanies(description, retained).investors.map(
    (investor) => ({
      ...investor,
      source_verification: "provider_reported_unverified" as const,
      approach_ready: false,
    }),
  );
  return {
    format: "funding-radar-reviewed-case-v1" as const,
    description,
    startup: report.startup,
    collection_mode: observations.mode,
    mode:
      observations.mode === "synthetic_fixture"
        ? review
          ? ("synthetic_fixture_with_separate_source_review" as const)
          : ("synthetic_fixture_review_pending" as const)
        : review
          ? ("saved_live_with_separate_source_review" as const)
          : ("saved_live_review_pending" as const),
    window: report.window,
    original: {
      dataset_id: report.dataset_id,
      run_id: report.run_id,
      collected_at: report.collected_at,
      observations_sha256: sha256(originalBytes),
    },
    rows,
    investor_candidates: candidates,
    approach_ready_investors: [],
    review,
    coverage: {
      required: 10,
      returned_by_tinyset: rows.length,
      provider_reported_qualifying:
        report.coverage.distinct_recent_similar_companies,
      independently_reviewed_recent: verified.size,
      contradicted_or_excluded: excluded.size,
      review_pending: rows.filter(
        (r) =>
          r.source_status === "not_reviewed" ||
          r.source_status === "unresolved",
      ).length,
      complete: verified.size >= 10,
    },
    blockers: [
      ...new Set([
        ...(verified.size < 10
          ? [
              "Ten independently supported recent comparable companies are not established.",
            ]
          : []),
        "A complete investor shortlist with sourced typical cheques, exact deal partners and contact routes is not established.",
        ...(review?.blockers ?? []),
      ]),
    ],
    submission_ready: false,
    fresh_research_enabled: false,
    warning:
      (observations.mode === "synthetic_fixture"
        ? "Synthetic fixture: not provider execution or real investment proof. "
        : "") +
      (review
        ? "Saved TinySet research with a separate dated source review. "
        : "Saved TinySet research; independent source review is pending. ") +
      "Candidate scores are heuristics, not verification or current investor mandates. No provider operation starts from this preview.",
  };
}
