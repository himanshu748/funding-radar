import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildReviewedCase, sha256 } from "../src/review.js";
import { attachPublicSupplement } from "../src/supplement.js";
const original = await readFile(
  new URL("../evidence/recent-2-observations.json", import.meta.url),
);
const review = JSON.parse(
  await readFile(
    new URL("../evidence/readiness-2026-11-10/case-2.json", import.meta.url),
    "utf8",
  ),
);
const receipt = JSON.parse(
  await readFile(
    new URL("../evidence/recent-2-receipt.json", import.meta.url),
    "utf8",
  ),
);
const source = JSON.parse(
  await readFile(
    new URL(
      "../evidence/completion-2026-11-11/case-2-supplement.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const base = () => buildReviewedCase(receipt.description, original, review, 2);
const attach = (value: unknown) =>
  attachPublicSupplement(base(), Buffer.from(JSON.stringify(value)), 2);
test("combined source coverage never increases TinySet-returned rows or changes original receipt identity", () => {
  const result = attach(source);
  assert.equal(result.coverage.returned_by_tinyset, 10);
  assert.equal(result.coverage.reviewed_tinyset_companies, 8);
  assert.equal(result.coverage.ordinary_web_supplement_companies, 2);
  assert.equal(result.coverage.independently_reviewed_recent, 10);
  assert.equal(result.rows.length, 12);
  assert.equal(result.original.observations_sha256, sha256(original));
  assert.equal(result.original.dataset_id, receipt.dataset_id);
  assert.equal(result.submission_ready, false);
  assert.deepEqual(result.approach_ready_investors, []);
});
test("new company records are explicit public-source additions with no forged original TinySet claim", () => {
  const result = attach(source);
  const added = result.rows.filter(
    (r) => r.record_origin === "ordinary_web_supplement",
  );
  assert.equal(added.length, 2);
  assert.ok(
    added.every(
      (r) =>
        r.original_claim === null &&
        r.evidence?.provenance === "ordinary_web_source_review",
    ),
  );
  assert.ok(result.public_source_supplement.returned_by_tinyset === false);
  assert.equal(
    result.investor_candidates.length,
    base().investor_candidates.length,
  );
});
test("a public-source file cannot claim provider provenance or bind a different case or source digest", () => {
  const a = structuredClone(source);
  a.returned_by_tinyset = true;
  assert.throws(() => attach(a));
  const b = structuredClone(source);
  b.case_id = 1;
  assert.throws(() => attach(b));
  const c = structuredClone(source);
  c.base_observations_sha256 = "0".repeat(64);
  assert.throws(() => attach(c));
});
test("duplicate identities, including www aliases, cannot inflate company coverage", () => {
  const a = structuredClone(source);
  a.companies[1].company_url = a.companies[0].company_url.replace(
    "https://www.",
    "https://",
  );
  assert.throws(() => attach(a));
  const b = structuredClone(source);
  b.companies[0].company_url = base().rows[0]!.company_url;
  assert.throws(() => attach(b));
  const c = structuredClone(source);
  c.companies[1].company_name = c.companies[0].company_name;
  assert.throws(() => attach(c));
  const legalAlias = structuredClone(source);
  legalAlias.companies[0].company_name = base().rows[0]!.company_name + " Ltd";
  legalAlias.companies[0].company_url =
    "https://funding." + new URL(base().rows[0]!.company_url!).hostname + "/";
  assert.throws(() => attach(legalAlias));
  const differentNameSubdomain = structuredClone(source);
  differentNameSubdomain.companies[0].company_url =
    legalAlias.companies[0].company_url;
  assert.throws(() => attach(differentNameSubdomain));
});
test("unreviewed events, partial boundary months and shifted demonstration windows fail closed", () => {
  const a = structuredClone(source);
  a.companies[0].decision = "unresolved";
  assert.throws(() => attach(a));
  const b = structuredClone(source);
  b.companies[0].announced_on = null;
  b.companies[0].announced_month = "2025-05";
  assert.throws(() => attach(b));
  const c = structuredClone(source);
  c.window.as_of = "2026-11-11";
  assert.throws(() => attach(c));
  const d = structuredClone(source);
  d.checked_at = new Date(Date.now() + 60000).toISOString();
  assert.throws(() => attach(d));
  const missingEvidence = structuredClone(source);
  missingEvidence.companies[0].sources = [];
  assert.throws(() => attach(missingEvidence));
  const missingFit = structuredClone(source);
  missingFit.companies[0].sources.forEach(
    (item: { supports: string[] }) =>
      (item.supports = item.supports.filter(
        (field: string) => field !== "fit",
      )),
  );
  assert.throws(() => attach(missingFit));
});
