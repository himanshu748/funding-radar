import { readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { FundingError, planFunding, rankInvestors } from "./core.js";
import { csvCell } from "../../zombie-check/src/csv.js";
import { planRecentFunding, rankRecentCompanies } from "./recent.js";

async function main() {
  const [command, description, input, output] = process.argv.slice(2);
  if (command === "recent-plan" && description && input && !output) {
    await writeFile(
      resolve(input),
      JSON.stringify(planRecentFunding(description), null, 2) + "\n",
      { flag: "wx" },
    );
    process.stdout.write(
      "Wrote an offline10-row recent-company plan; provider calls:0; minimum row estimate:$1.00.\n",
    );
    return;
  }
  if (command === "recent-report" && description && input && output) {
    if ((await stat(input)).size > 250000)
      throw new FundingError("INPUT_LIMIT", "Observation file exceeds250KB.");
    let data: unknown;
    try {
      data = JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(await readFile(input)),
      );
    } catch {
      throw new FundingError(
        "INVALID_JSON",
        "Use a valid UTF-8 JSON observation file.",
      );
    }
    const report = rankRecentCompanies(description, data);
    const encoded = output.endsWith(".csv")
      ? [
          [
            "company",
            "announced_on",
            "announced_month",
            "announcement_precision",
            "investor",
            "stage",
            "cheque_min",
            "cheque_max",
            "cheque_currency",
            "lead_partner",
            "contact_route",
            "evidence_url",
            "unknowns",
            "mode",
          ],
          ...report.rows.map((r) => [
            r.company_name,
            r.announced_on ?? "",
            r.announced_month ?? "",
            r.announcement_precision ?? "",
            r.investor_name,
            r.round_stage ?? "",
            String(r.cheque?.minimum ?? ""),
            String(r.cheque?.maximum ?? ""),
            r.cheque?.currency ?? "",
            r.lead_partner?.name ?? "",
            r.contact_route?.url ?? "",
            r.evidence?.url ?? "",
            r.unknowns.join(" "),
            report.mode,
          ]),
        ]
          .map((row) => row.map(csvCell).join(","))
          .join("\n") + "\n"
      : JSON.stringify(report, null, 2) + "\n";
    await writeFile(resolve(output), encoded, { flag: "wx" });
    process.stdout.write(
      `Reconciled ${report.coverage.distinct_recent_similar_companies} distinct recent comparable companies from ${report.mode}; provider calls:0.\n`,
    );
    return;
  }
  if (command === "plan" && description && input && !output) {
    await writeFile(
      resolve(input),
      JSON.stringify(planFunding(description), null, 2) + "\n",
      { flag: "wx" },
    );
    process.stdout.write(
      "Wrote offline 5-row plan; provider calls: 0; minimum row estimate: $0.50.\n",
    );
    return;
  }
  if (command === "rank" && description && input && output) {
    if ((await stat(input)).size > 100_000)
      throw new FundingError("INPUT_LIMIT", "Observation file exceeds 100 KB.");
    const bytes = await readFile(input),
      text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new FundingError(
        "INVALID_JSON",
        "Observation file must contain valid JSON.",
      );
    }
    const report = rankInvestors(description, data);
    const encoded = output.endsWith(".csv")
      ? [
          [
            "investor",
            "score",
            "status",
            "official_evidence_url",
            "why",
            "unknowns",
            "mode",
          ],
          ...report.rows.map((r) => [
            r.investor_name,
            String(r.score),
            r.status,
            r.evidence?.url ?? "",
            r.reasons.join(" "),
            r.unknowns.join(" "),
            report.mode,
          ]),
        ]
          .map((row) => row.map(csvCell).join(","))
          .join("\n") + "\n"
      : JSON.stringify(report, null, 2) + "\n";
    await writeFile(resolve(output), encoded, { flag: "wx" });
    process.stdout.write(
      `Ranked ${report.rows.length} supplied rows in ${report.mode} mode; provider calls: 0.\n`,
    );
    return;
  }
  throw new FundingError(
    "USAGE",
    'Usage: cli.ts recent-plan "one-line startup" new-plan.json | recent-report "one-line startup" observations-v2.json new-report.json|csv | legacy plan "one-line startup" new-plan.json | rank "one-line startup" observations.json new-report.json|csv',
  );
}
main().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({
      error:
        error instanceof FundingError
          ? { code: error.code, message: error.message }
          : {
              code: "LOCAL_FAILURE",
              message:
                "Local command failed. Check paths, UTF-8 and permissions; existing outputs are never overwritten.",
            },
    }) + "\n",
  );
  process.exitCode = 1;
});
