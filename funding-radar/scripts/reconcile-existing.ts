import { readFile, writeFile, rename } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { load } from "cheerio";
import { rankRecentCompanies, parseRecentObservations } from "../src/recent.js";
import {
  attachRecordedAudit,
  parseRecordedAudit,
} from "../src/recorded-audit.js";

const root = process.cwd(),
  directory = process.argv[2];
if (directory && !isAbsolute(directory))
  throw new Error(
    "Use an absolute directory containing the existing source receipts.",
  );
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
async function atomicJson(path: string, value: unknown) {
  const temporary = path + ".local-" + randomUUID();
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, path);
}
const auditBytes = await readFile(
  join(root, "funding-radar/evidence/source-audit-v2.json"),
);
const audit = parseRecordedAudit(JSON.parse(auditBytes.toString("utf8"))),
  texts = new Map<string, string>();
if (directory)
  for (const outcome of audit.outcomes) {
    if (outcome.status !== "fetched") continue;
    const saved = JSON.parse(
      await readFile(
        join(directory, `source-${outcome.index}-private.json`),
        "utf8",
      ),
    ) as { html: string; source_url: string };
    if (saved.source_url !== outcome.url)
      throw new Error("Saved source identity differs from audit.");
    const $ = load(saved.html);
    $("script,style").remove();
    const text = $("body").text().replace(/\s+/g, " ").trim();
    if (digest(text) !== outcome.text_sha256)
      throw new Error("Saved source digest differs from audit.");
    texts.set(outcome.url, text);
  }
const summaries = [];
for (let index = 1; index <= 3; index++) {
  const prefix = join(root, `funding-radar/evidence/recent-${index}`);
  const paths = ["observations", "receipt", "report"].map(
      (name) => `${prefix}-${name}.json`,
    ),
    before = await Promise.all(paths.map((path) => readFile(path)));
  const originalHashes = Object.fromEntries(
    paths.map((path, i) => [path.split("/").at(-1)!, digest(before[i]!)]),
  );
  const observations = parseRecentObservations(
      JSON.parse(before[0]!.toString("utf8")),
    ),
    receipt = JSON.parse(before[1]!.toString("utf8")) as {
      description: string;
      run_id: string;
      dataset_id: string;
    };
  const report = attachRecordedAudit(
    rankRecentCompanies(receipt.description, observations),
    observations,
    audit,
    texts,
  );
  const previous = JSON.parse(
      await readFile(prefix + "-reconciliation.json", "utf8"),
    ) as Record<string, unknown>,
    oldReport = await readFile(prefix + "-reconciled-report.json");
  const metadata = {
    ...previous,
    kind: "offline_normalization_reconciliation",
    new_provider_operations: 0,
    original_run_id: receipt.run_id,
    original_dataset_id: receipt.dataset_id,
    original_artifact_sha256: originalHashes,
    previous_reconciled_report_sha256: digest(oldReport),
    current_engine_sha256: digest(
      await readFile(join(root, "funding-radar/src/recent.ts")),
    ),
    audit_engine_sha256: digest(
      await readFile(join(root, "funding-radar/src/recorded-audit.ts")),
    ),
    source_audit_sha256: digest(auditBytes),
    reconciled_at: new Date().toISOString(),
    source_observed_at: observations.collected_at,
    reconciled_coverage: report.coverage,
    date_precision_counts: {
      day: report.rows.filter((r) => r.announcement_precision === "day").length,
      month: report.rows.filter((r) => r.announcement_precision === "month")
        .length,
      unestablished: report.rows.filter((r) => !r.announcement_precision)
        .length,
    },
    source_audit: report.source_audit,
    changes: [
      "Use dates stated exactly in ISO or English; never emit an unsupported exact day.",
      "Preserve an explicitly stated month only when its complete date range lies inside the research window; exact day stays null.",
      "Retain primary and third-party provenance allowed by the authenticated brief.",
      "Attach actual existing source-check outcomes and hash-checked text-presence tests. Retrieval never becomes semantic verification.",
    ],
    material_source_review_reference: "official-source-review.json",
    source_verification: "provider_reported_unverified",
    automatic_retry: false,
  };
  const encoded = JSON.stringify({ report, metadata });
  if (
    /(?:TINYFISH_API_KEY\s*=|Bearer\s+[A-Za-z0-9_-]{16,}|-----BEGIN .*PRIVATE KEY-----)/i.test(
      encoded,
    )
  )
    throw new Error("Sensitive-pattern export withheld.");
  await atomicJson(prefix + "-reconciled-report.json", report);
  await atomicJson(prefix + "-reconciliation.json", metadata);
  const after = await Promise.all(paths.map((path) => readFile(path)));
  if (after.some((value, i) => digest(value) !== digest(before[i]!)))
    throw new Error("An immutable original artifact changed.");
  summaries.push({
    input: index,
    description: receipt.description,
    coverage: report.coverage,
    investors: report.investors.length,
    date_precision: metadata.date_precision_counts,
    source_checks: report.source_audit,
    unknown_fields: {
      cheque: report.rows.filter((r) => !r.cheque).length,
      lead_partner: report.rows.filter((r) => !r.lead_partner).length,
      contact_route: report.rows.filter((r) => !r.contact_route).length,
    },
  });
}
await atomicJson(join(root, "funding-radar/evidence/reconciled-summary.json"), {
  kind: "funding-radar-existing-evidence-finalization",
  new_provider_operations: 0,
  originals_preserved: true,
  generated_at: new Date().toISOString(),
  inputs: summaries,
});
process.stdout.write(
  JSON.stringify(
    summaries.map((s) => ({
      input: s.input,
      eligible: s.coverage.distinct_recent_similar_companies,
      investors: s.investors,
      precision: s.date_precision,
      audited_rows: s.source_checks.rows_with_retrieved_source,
    })),
  ) + "\n",
);
