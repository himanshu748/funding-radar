import { z } from "zod";
import { createHash } from "node:crypto";
import { publicUrl } from "../../zombie-check/src/urls.js";
import {
  fundingDateMentioned,
  type RecentCollection,
  rankRecentCompanies,
} from "./recent.js";

const Outcome = z
  .object({
    url: z.string(),
    index: z.number().int().min(1).max(20),
    status: z.enum(["fetched", "not_corroborated"]),
    observed_at: z.string().optional(),
    text_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    error: z.string().optional(),
    metadata: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .optional(),
  })
  .passthrough()
  .superRefine((o, c) => {
    if (o.status === "fetched" && (!o.text_sha256 || !o.observed_at))
      c.addIssue({
        code: "custom",
        message: "A fetched source needs its recorded time and body digest.",
      });
  });
const Audit = z
  .object({
    kind: z.literal("funding-source-audit-v2"),
    provider: z.literal("tinyfish-fetch"),
    distinct_source_checks: z.number().int().max(20),
    reservation_unit_price_microusd: z.literal(0),
    halted: z.boolean(),
    outcomes: z.array(Outcome).max(20),
  })
  .passthrough();
export type RecordedAudit = z.infer<typeof Audit>;
export type RecentReport = ReturnType<typeof rankRecentCompanies>;
export function parseRecordedAudit(value: unknown): RecordedAudit {
  const audit = Audit.parse(value);
  const urls = audit.outcomes.map((o) => publicUrl(o.url));
  if (
    new Set(urls).size !== urls.length ||
    urls.length !== audit.distinct_source_checks
  )
    throw new Error("Source audit identities or count are inconsistent.");
  return audit;
}
function identity(value: string) {
  const u = new URL(publicUrl(value));
  u.hostname = u.hostname.replace(/^www\./, "");
  u.pathname = u.pathname.replace(/\/+$/, "") || "/";
  return u.href;
}
const normalized = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Replay actual saved checks. A retrieved page is never promoted to a verified investment. */
export function attachRecordedAudit(
  report: RecentReport,
  observations: RecentCollection,
  value: unknown,
  texts: ReadonlyMap<string, string> = new Map(),
) {
  const audit = parseRecordedAudit(value);
  const originals = new Map(observations.rows.map((r) => [r._id, r.data]));
  const rows = report.rows.map((row) => {
    const original = originals.get(row.row_id),
      candidate =
        typeof original?.evidence_url === "string"
          ? original.evidence_url
          : null;
    let outcome: RecordedAudit["outcomes"][number] | undefined;
    try {
      if (candidate)
        outcome = audit.outcomes.find(
          (o) => identity(o.url) === identity(candidate),
        );
    } catch {}
    if (!outcome)
      return {
        ...row,
        source_corroboration: {
          status: "not_checked" as const,
          semantic_verification: "not_established" as const,
        },
      };
    if (outcome.status !== "fetched")
      return {
        ...row,
        source_corroboration: {
          status: "not_corroborated" as const,
          checked_url: outcome.url,
          error: outcome.error ?? "SOURCE_CHECK_FAILED",
          semantic_verification: "not_established" as const,
        },
      };
    const text = texts.get(outcome.url),
      date =
        typeof original?.announced_on === "string"
          ? original.announced_on
          : null;
    if (
      text !== undefined &&
      createHash("sha256").update(text).digest("hex") !== outcome.text_sha256
    )
      throw new Error("Recorded source body does not match the audit digest.");
    const publishedDays = (outcome.metadata ?? [])
      .filter((m) => /published/i.test(m.name))
      .flatMap((m) =>
        /^\d{4}-\d{2}-\d{2}T/.test(m.value) ? [m.value.slice(0, 10)] : [],
      );
    return {
      ...row,
      source_corroboration: {
        status: "text_retrieved" as const,
        checked_url: outcome.url,
        url_match:
          outcome.url === candidate
            ? "exact"
            : "reviewed_www_or_trailing_slash_alias",
        observed_at: outcome.observed_at ?? null,
        text_sha256: outcome.text_sha256 ?? null,
        semantic_verification: "not_established" as const,
        text_checks:
          text === undefined
            ? null
            : {
                company_name_present:
                  row.company_name.length >= 2 &&
                  normalized(text).includes(normalized(row.company_name)),
                investor_name_present:
                  row.investor_name.length >= 2 &&
                  normalized(text).includes(normalized(row.investor_name)),
                supplied_exact_day_literal_present: date
                  ? fundingDateMentioned(text, date)
                  : false,
              },
        published_days: publishedDays,
      },
    };
  });
  return {
    ...report,
    rows,
    source_audit: {
      provider: "tinyfish-fetch",
      artifact: "source-audit-v2.json",
      original_source_operations: audit.distinct_source_checks,
      new_provider_operations: 0,
      unit_price_microusd: 0,
      fetched: audit.outcomes.filter((o) => o.status === "fetched").length,
      not_corroborated: audit.outcomes.filter((o) => o.status !== "fetched")
        .length,
      halted: audit.halted,
      rows_with_retrieved_source: rows.filter(
        (r) => r.source_corroboration.status === "text_retrieved",
      ).length,
      rows_with_uncorroborated_source: rows.filter(
        (r) => r.source_corroboration.status === "not_corroborated",
      ).length,
      rows_not_checked: rows.filter(
        (r) => r.source_corroboration.status === "not_checked",
      ).length,
      warning:
        "Retrieval, text presence and publication metadata are separate from semantic investment verification. Redirect rejections were not retried.",
    },
  };
}
