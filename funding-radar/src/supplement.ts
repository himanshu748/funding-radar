import { z } from "zod";
import { CaseReviewSchema, sha256, type buildReviewedCase } from "./review.js";
import { publicUrl } from "../../zombie-check/src/urls.js";
import { FundingError } from "./core.js";
const publicSource = z.string().transform((value) => publicUrl(value));
const company = CaseReviewSchema.shape.rows.element.safeExtend({
  row_id: z.string().regex(/^public:[a-z0-9-]{2,100}$/),
  company_url: publicSource,
  round_stage: z.string().max(100).nullable(),
  geography: z.string().max(150).nullable(),
  fit: z.string().min(20).max(1500),
  investors: z
    .array(
      z.object({
        name: z.string().min(2).max(200),
        url: publicSource,
        role: z.string().max(150),
        source_url: publicSource,
        note: z.string().min(10).max(1500),
      }),
    )
    .min(1)
    .max(10),
});
export const PublicSupplementSchema = z
  .object({
    format: z.literal("funding-radar-public-source-supplement-v1"),
    case_id: z.number().int().min(1).max(3),
    checked_at: z.iso.datetime({ offset: true }),
    method: z.literal("ordinary_web_source_review"),
    returned_by_tinyset: z.literal(false),
    base_observations_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    window: z.object({ since: z.iso.date(), as_of: z.iso.date() }).strict(),
    scope: z.string().min(20).max(2000),
    companies: z.array(company).min(1).max(20),
    investor_reviews: CaseReviewSchema.shape.investors,
    provider_operations_started: z.literal(0),
  })
  .strict();
export type PublicSupplement = z.infer<typeof PublicSupplementSchema>;
type BaseCase = ReturnType<typeof buildReviewedCase>;
const companyIdentity = (url: string) =>
  new URL(url).hostname.toLowerCase().replace(/^www\./, "");
const sameCompanyHost = (left: string, right: string) =>
  left === right || left.endsWith("." + right) || right.endsWith("." + left);
const companyNameIdentity = (name: string) =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(
      /(?:\s+(?:incorporated|inc|limited|ltd|llc|corporation|corp|gmbh|plc|pvt|private|bv))+$/,
      "",
    )
    .trim();

/** Adds independently researched public sources without forging TinySet rows or changing the original receipt. */
export function attachPublicSupplement(
  base: BaseCase,
  bytes: Buffer,
  expectedCaseId: number,
) {
  if (base.collection_mode !== "saved_live")
    throw new FundingError(
      "SUPPLEMENT_PROVENANCE_INVALID",
      "Ordinary-web additions cannot turn synthetic source rows into a TinySet demonstration.",
    );
  const supplement = PublicSupplementSchema.parse(
    JSON.parse(bytes.toString("utf8")),
  );
  if (
    supplement.case_id !== expectedCaseId ||
    supplement.base_observations_sha256 !== base.original.observations_sha256
  )
    throw new FundingError(
      "SUPPLEMENT_IDENTITY_MISMATCH",
      "Public-source additions must match this case and original observation digest.",
    );
  if (
    supplement.window.since !== base.window.since ||
    supplement.window.as_of !== base.window.as_of
  )
    throw new FundingError(
      "SUPPLEMENT_WINDOW_MISMATCH",
      "Keep the original demonstration's historical funding window.",
    );
  if (
    Date.parse(supplement.checked_at) > Date.now() + 5000 ||
    Date.parse(supplement.checked_at) < Date.parse(base.original.collected_at)
  )
    throw new FundingError(
      "SUPPLEMENT_TIME_INVALID",
      "Source-review time must follow collection and cannot be in the future.",
    );
  const knownDomains = new Set(
    base.rows.flatMap((row) =>
      row.company_url ? [companyIdentity(row.company_url)] : [],
    ),
  );
  const knownNames = new Set(
    base.rows.map((row) => companyNameIdentity(row.company_name)),
  );
  const ids = new Set(base.rows.map((row) => row.row_id));
  for (const row of supplement.companies) {
    const identity = companyIdentity(row.company_url),
      name = companyNameIdentity(row.company_name);
    if (
      [...knownDomains].some((known) => sameCompanyHost(known, identity)) ||
      knownNames.has(name) ||
      ids.has(row.row_id)
    )
      throw new FundingError(
        "SUPPLEMENT_DUPLICATE",
        "A public-source addition cannot duplicate a company already in the case.",
      );
    if (row.decision !== "verified_recent")
      throw new FundingError(
        "SUPPLEMENT_NOT_SUPPORTED",
        "Count a public-source addition only after its identity, completed round, period and fit are reviewed.",
      );
    if (
      row.announced_on &&
      row.announced_month &&
      !row.announced_on.startsWith(row.announced_month + "-")
    )
      throw new FundingError(
        "SUPPLEMENT_WINDOW_MISMATCH",
        "Reviewed announcement day and month disagree.",
      );
    const start = row.announced_on ?? row.announced_month + "-01";
    const [year, month] = (row.announced_month ?? row.announced_on!.slice(0, 7))
      .split("-")
      .map(Number);
    const end =
      row.announced_on ??
      new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10);
    if (start < base.window.since || end > base.window.as_of)
      throw new FundingError(
        "SUPPLEMENT_WINDOW_MISMATCH",
        "A new company must lie wholly inside the original historical funding window.",
      );
    knownDomains.add(identity);
    knownNames.add(name);
    ids.add(row.row_id);
  }
  const originals = base.rows.map((row) => ({
    ...row,
    record_origin: "tinyset" as const,
  }));
  const additions = supplement.companies.map((row) => ({
    row_id: row.row_id,
    company_name: row.company_name,
    company_url: row.company_url,
    announced_on: row.announced_on,
    announced_month:
      row.announced_month ?? row.announced_on?.slice(0, 7) ?? null,
    announcement_precision: row.announced_on
      ? ("day" as const)
      : ("month" as const),
    qualifying_recent_company: true,
    sector_overlap: [],
    geography: row.geography,
    round_stage: row.round_stage,
    investor_name: row.investors.map((i) => i.name).join(", "),
    investor_url: row.investors.length === 1 ? row.investors[0]!.url : null,
    cheque: null,
    lead_partner: null,
    contact_route: null,
    unknowns: row.withheld_fields.map(
      (field) => "Not established: " + field.replaceAll("_", " "),
    ),
    evidence: {
      url: row.sources[0]!.url,
      summary: row.fit,
      collected_at: supplement.checked_at,
      provenance: "ordinary_web_source_review" as const,
      source_type: row.sources[0]!.kind,
    },
    original_claim: null,
    review: row,
    source_status: "verified_recent" as const,
    review_required: true,
    record_origin: "ordinary_web_supplement" as const,
  }));
  const rows = [...originals, ...additions];
  const reviewed = new Set(
    rows
      .filter(
        (row) => row.source_status === "verified_recent" && row.company_url,
      )
      .map((row) => companyIdentity(row.company_url!)),
  );
  const coverageComplete = reviewed.size >= base.coverage.required;
  return {
    ...base,
    mode: "saved_tinyset_with_public_source_supplement" as const,
    rows,
    public_source_supplement: {
      checked_at: supplement.checked_at,
      sha256: sha256(bytes),
      company_count: additions.length,
      returned_by_tinyset: false,
      scope: supplement.scope,
      investor_reviews: supplement.investor_reviews,
    },
    coverage: {
      ...base.coverage,
      scope: "combined_source_review_only" as const,
      automated_discovery_complete: false,
      independently_reviewed_recent: reviewed.size,
      reviewed_tinyset_companies: base.coverage.independently_reviewed_recent,
      ordinary_web_supplement_companies: additions.length,
      presented_company_rows: rows.length,
      complete: coverageComplete,
      provider_only_complete:
        base.coverage.independently_reviewed_recent >= base.coverage.required,
    },
    prior_review_blockers: base.blockers,
    blockers: [
      ...(!coverageComplete
        ? [
            "Ten supported recent comparables are not established even after public-source additions.",
          ]
        : []),
      "Supplementary company research is ordinary-web review, not a new TinySet result or proof of automated discovery.",
      "A complete investor shortlist with sourced typical cheques, exact deal partners and contact routes is not established.",
      "Fresh arbitrary-input end-to-end research, final public access, media, promotion and submission checks remain open.",
    ],
    warning:
      "The original TinySet observations and receipt are unchanged. Additional public-source companies were researched separately and do not increase provider-returned row counts. Combined coverage does not establish an approach-ready investor list or submission readiness.",
    submission_ready: false,
  };
}
