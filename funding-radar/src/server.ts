import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, lstat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { buildReviewedCase, sha256 } from "./review.js";
import { attachPublicSupplement } from "./supplement.js";
import { rankReviewedInvestors } from "./reviewed-ranking.js";
import { FundingResearchSessions } from "./research-session.js";
import { buildRecordedInvestigation } from "./recording.js";
import { planRecentFunding, parseRecentObservations } from "./recent.js";
import { FundingError } from "./core.js";
import { csvCell } from "../../zombie-check/src/csv.js";

const base = new URL("../", import.meta.url);
const descriptions = [
  "US seed software startup building AI code review tools for developer teams",
  "UK seed climate software startup building energy forecasting for grid operators",
  "India Series A fintech startup building payments software for small businesses",
];
const labels = ["Developer tools", "Climate & energy", "Fintech & payments"];
const recordingDirectory = new URL("evidence/recorded-investigations/", base);
const recordingFile = z.string().regex(/^[a-z][a-z0-9-]{1,100}\.json$/);
const catalogSchema = z
  .object({
    format: z.literal("funding-radar-recording-catalog-v1"),
    recordings: z
      .array(
        z
          .object({
            id: z.uuid(),
            label: z.string().min(3).max(80),
            source_file: recordingFile,
            source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
            review_file: recordingFile.optional(),
            review_sha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            ranking_file: recordingFile.optional(),
            ranking_sha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
async function readRecordingFile(name: string, expectedSha?: string) {
  const url = new URL(recordingFile.parse(name), recordingDirectory);
  const info = await lstat(url);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000)
    throw new FundingError(
      "INVALID_RECORDING",
      "Use bounded regular recording files from the evidence directory.",
    );
  const bytes = await readFile(url);
  if (expectedSha && sha256(bytes) !== expectedSha)
    throw new FundingError(
      "INVALID_RECORDING",
      "Recording evidence differs from its catalog hash.",
    );
  return bytes;
}
async function loadRecordings() {
  let bytes: Buffer;
  try {
    bytes = await readRecordingFile("catalog.json");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const catalog = catalogSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (
    new Set(catalog.recordings.map((r) => r.id)).size !==
    catalog.recordings.length
  )
    throw new FundingError(
      "INVALID_RECORDING",
      "Recording identities must be unique.",
    );
  return Promise.all(
    catalog.recordings.map(async (entry) => {
      if (
        !!entry.review_file !== !!entry.review_sha256 ||
        !!entry.ranking_file !== !!entry.ranking_sha256
      )
        throw new FundingError(
          "INVALID_RECORDING",
          "Every optional review file needs its own digest.",
        );
      const source = await readRecordingFile(
        entry.source_file,
        entry.source_sha256,
      );
      const review = entry.review_file
        ? JSON.parse(
            (
              await readRecordingFile(entry.review_file, entry.review_sha256)
            ).toString("utf8"),
          )
        : undefined;
      const ranking = entry.ranking_file
        ? JSON.parse(
            (
              await readRecordingFile(entry.ranking_file, entry.ranking_sha256)
            ).toString("utf8"),
          )
        : undefined;
      const data = buildRecordedInvestigation(
        source,
        entry.label,
        review,
        ranking,
      );
      if (data.id !== entry.id)
        throw new FundingError(
          "INVALID_RECORDING",
          "The recording and catalog identify different investigations.",
        );
      return data;
    }),
  );
}
async function recordedCase(id: string) {
  return (await loadRecordings()).find((data) => data.id === id);
}
export async function loadFundingCase(id: number) {
  if (![1, 2, 3].includes(id))
    throw new FundingError(
      "CASE_NOT_FOUND",
      "Choose one of the three recorded investigations.",
    );
  const receipt = JSON.parse(
    await readFile(
      new URL("evidence/recent-" + id + "-receipt.json", base),
      "utf8",
    ),
  ) as { description: string; dataset_id: string; run_id: string };
  const original = await readFile(
    new URL("evidence/recent-" + id + "-observations.json", base),
  );
  const parsed = parseRecentObservations(JSON.parse(original.toString("utf8")));
  if (
    receipt.dataset_id !== parsed.dataset_id ||
    receipt.run_id !== parsed.run_id
  )
    throw new FundingError(
      "RECEIPT_IDENTITY_MISMATCH",
      "Original observations and transport receipt differ.",
    );
  let review: unknown;
  try {
    review = JSON.parse(
      await readFile(
        new URL("evidence/readiness-2026-11-10/case-" + id + ".json", base),
        "utf8",
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const reviewed = buildReviewedCase(
    receipt.description || descriptions[id - 1]!,
    original,
    review,
    id,
  );
  let supplementalBytes: Buffer | undefined;
  try {
    supplementalBytes = await readFile(
      new URL(
        "evidence/completion-2026-11-11/case-" + id + "-supplement.json",
        base,
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const data = {
    id,
    label: labels[id - 1],
    ...(supplementalBytes
      ? attachPublicSupplement(reviewed, supplementalBytes, id)
      : reviewed),
  };
  let rankingValue: unknown;
  try {
    rankingValue = JSON.parse(
      await readFile(
        new URL(
          `evidence/readiness-final-2026-11-11/case-${id}-ranking.json`,
          base,
        ),
        "utf8",
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (rankingValue === undefined) return data;
  const shortlist = rankReviewedInvestors(data, rankingValue);
  return {
    ...data,
    reviewed_shortlist: shortlist,
    approach_ready_investors: shortlist.investors.filter(
      (investor) => investor.approach_ready,
    ),
    warning:
      "Original TinySet evidence, later company reviews and the selected reviewed investor shortlist remain separate. Named deal responsibility, dated cheque policy and current founder routes retain their source qualifications. Historical backing does not promise present interest or funding.",
    blockers: [
      ...(!data.coverage.complete
        ? ["Ten supported recent comparables are not established."]
        : []),
      ...(!shortlist.investors.some((investor) => investor.approach_ready)
        ? [
            "No stage-suitable, fully documented investor is in the selected shortlist.",
          ]
        : []),
      "Current release, live workflow verification, access, promotion and final submission checks are tracked separately from saved-case source completeness.",
    ],
  };
}
const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
};
async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 4096)
      throw new FundingError(
        "INPUT_LIMIT",
        "Keep the startup description below 1,000 characters.",
      );
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new FundingError("INVALID_JSON", "Use a JSON startup description.");
  }
}
interface ExportData {
  mode: string;
  rows: Array<{
    company_name: string;
    record_origin?: string;
    announced_on: string | null;
    source_status: string;
    investor_name: string;
    evidence: { url: string | null } | null;
    review: {
      announced_on: string | null;
      announced_month: string | null;
      sources: Array<{ url: string }>;
      notes: string[];
    } | null;
  }>;
}
function exportCase(
  res: ServerResponse,
  data: ExportData,
  id: string,
  extension?: string,
) {
  if (extension)
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="funding-radar-${id}.${extension}"`,
    );
  if (extension !== "csv") return json(res, 200, data);
  const lines: unknown[][] = [
    [
      "company",
      "record_origin",
      "provider_announced_on",
      "review_status",
      "reviewed_announced_on",
      "reviewed_announced_month",
      "investor_candidate",
      "source_url",
      "review_sources",
      "review_notes",
      "provenance",
    ],
  ];
  for (const row of data.rows)
    lines.push([
      row.company_name,
      row.record_origin ?? "tinyset",
      row.record_origin === "ordinary_web_supplement"
        ? ""
        : (row.announced_on ?? ""),
      row.source_status,
      row.review?.announced_on ?? "",
      row.review?.announced_month ?? "",
      row.investor_name,
      row.evidence?.url ?? "",
      row.review?.sources.map((s) => s.url).join(" ") ?? "",
      row.review?.notes.join(" ") ?? "Review pending",
      data.mode,
    ]);
  res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
  return res.end(
    lines
      .map((line) => line.map((v) => csvCell(String(v))).join(","))
      .join("\n") + "\n",
  );
}
function configuredSessions(): FundingResearchSessions | undefined {
  if (
    process.env.FUNDING_RADAR_LIVE !== "1" ||
    process.env.BOUNTY_POOL_LIVE !== "1"
  )
    return undefined;
  const policyId = process.env.FUNDING_RADAR_POLICY_ID;
  if (!policyId)
    throw new FundingError(
      "INVALID_RESEARCH_CONFIG",
      "Select the explicitly authorized Funding Radar row policy before enabling live research.",
    );
  return new FundingResearchSessions({
    policyId,
    targetRows: Number(process.env.FUNDING_RADAR_TARGET_ROWS ?? 20),
    onProviderEvent: (event) => {
      process.stderr.write(
        JSON.stringify({ kind: "tinyset-request", ...event }) + "\n",
      );
    },
  });
}
export function createFundingServer(
  options: { sessions?: FundingResearchSessions | false } = {},
) {
  const sessions =
    options.sessions === false
      ? undefined
      : (options.sessions ?? configuredSessions());
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    const requestHost = req.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(requestHost))
      return json(res, 403, { error: "Local access only." });
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://" + requestHost);
    } catch {
      return json(res, 400, { error: "Invalid URL." });
    }
    if (req.headers.origin && req.headers.origin !== "http://" + requestHost)
      return json(res, 403, { error: "Use the local application origin." });
    try {
      if (req.method === "GET" && url.pathname === "/api/cases") {
        const [saved, recordings] = await Promise.all([
          Promise.all([1, 2, 3].map(loadFundingCase)),
          loadRecordings(),
        ]);
        const cases = [...saved, ...recordings];
        return json(res, 200, {
          cases: cases.map((data) => ({
            id: data.id,
            label: data.label,
            description: data.description,
            coverage: data.coverage,
            window: data.window,
            collected_at: data.original.collected_at,
            result_origin:
              "result_origin" in data ? data.result_origin : "recorded_live",
          })),
          fresh_research_enabled: !!sessions,
          ...(sessions ? { live_limits: sessions.limits } : {}),
          provider_operations_started: 0,
        });
      }
      const match = /^\/api\/case\/([1-3])(?:\.(json|csv))?$/.exec(
        url.pathname,
      );
      if (req.method === "GET" && match) {
        return exportCase(
          res,
          await loadFundingCase(Number(match[1])),
          `case-${match[1]}`,
          match[2],
        );
      }
      if (req.method === "POST" && url.pathname === "/api/plan") {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          return json(res, 415, { error: "Use application/json." });
        const input = z
          .object({ description: z.string().min(15).max(1000) })
          .strict()
          .parse(await readBody(req));
        return json(res, 200, {
          ...planRecentFunding(input.description, {
            targetRows: sessions?.limits.target_rows ?? 10,
          }),
          message:
            "Plan prepared locally. No research was started, no credits reserved, no saved result changed.",
        });
      }
      if (url.pathname === "/api/research") {
        if (!sessions)
          return json(res, 503, {
            error:
              "Fresh research is paused. The existing TinyFish allowance is exhausted; a new bounded authorization is required.",
            provider_operations_started: 0,
          });
        if (req.method !== "POST")
          return json(res, 405, {
            error: "Use POST to explicitly start a bounded investigation.",
          });
        if (!req.headers["content-type"]?.startsWith("application/json"))
          return json(res, 415, { error: "Use application/json." });
        const input = z
          .object({
            description: z.string().min(15).max(1000),
            request_id: z.uuid(),
          })
          .strict()
          .parse(await readBody(req));
        try {
          sessions.get(input.request_id);
          return json(res, 202, sessions.start(input));
        } catch (error) {
          if (
            !(error instanceof FundingError) ||
            error.code !== "RESEARCH_NOT_FOUND"
          )
            throw error;
        }
        const existingRecording = await recordedCase(
          input.request_id.toLowerCase(),
        );
        if (existingRecording) {
          if (existingRecording.description !== input.description)
            throw new FundingError(
              "RESEARCH_CONFLICT",
              "This request ID belongs to a different recorded startup description.",
            );
          return json(res, 202, {
            request_id: existingRecording.id,
            status: "complete",
            status_url: `/api/research/${existingRecording.id}`,
            result_url: existingRecording.export_base,
            result_origin: "recorded_live",
          });
        }
        return json(res, 202, sessions.start(input));
      }
      const job = /^\/api\/research\/([a-f0-9-]{36})(\/cancel)?$/.exec(
        url.pathname,
      );
      if (job) {
        if (req.method === "GET" && !job[2]) {
          if (sessions) {
            try {
              return json(res, 200, sessions.get(job[1]!));
            } catch (error) {
              if (
                !(error instanceof FundingError) ||
                error.code !== "RESEARCH_NOT_FOUND"
              )
                throw error;
            }
          }
          const recording = await recordedCase(job[1]!);
          if (!recording)
            throw new FundingError(
              "RESEARCH_NOT_FOUND",
              "No local session or completed recording exists for this request.",
            );
          return json(res, 200, {
            request_id: recording.id,
            status: "complete",
            status_url: `/api/research/${recording.id}`,
            result_url: recording.export_base,
            result_origin: "recorded_live",
          });
        }
        if (req.method === "POST" && job[2])
          return sessions
            ? json(res, 202, sessions.cancel(job[1]!))
            : json(res, 409, {
                error:
                  "Live research is disabled; a recording is not a running provider task.",
              });
        return json(res, 405, {
          error: "Use the research status or explicit cancellation action.",
        });
      }
      const investigation =
        /^\/api\/investigation\/([a-f0-9-]{36})(?:\.(json|csv))?$/.exec(
          url.pathname,
        );
      if (investigation && req.method === "GET") {
        if (sessions) {
          try {
            return exportCase(
              res,
              sessions.result(investigation[1]!),
              investigation[1]!,
              investigation[2],
            );
          } catch (error) {
            if (
              !(error instanceof FundingError) ||
              error.code !== "RESEARCH_NOT_FOUND"
            )
              throw error;
          }
        }
        const recording = await recordedCase(investigation[1]!);
        if (!recording)
          throw new FundingError(
            "RESEARCH_NOT_FOUND",
            "This investigation is not available in local memory or saved evidence.",
          );
        return exportCase(res, recording, investigation[1]!, investigation[2]);
      }
      if (req.method !== "GET")
        return json(res, 405, { error: "Method not allowed." });
      const files: Record<string, [URL, string]> = {
        "/": [new URL("web/index.html", base), "text/html; charset=utf-8"],
        "/app.js": [
          new URL("web/app.js", base),
          "text/javascript; charset=utf-8",
        ],
        "/style.css": [
          new URL("web/style.css", base),
          "text/css; charset=utf-8",
        ],
        "/fonts/manrope.woff2": [
          new URL("../ui/assets/manrope.woff2", base),
          "font/woff2",
        ],
        "/fonts/dmsans.woff2": [
          new URL("../ui/assets/dmsans.woff2", base),
          "font/woff2",
        ],
      };
      const asset = files[url.pathname];
      if (!asset) return json(res, 404, { error: "Not found." });
      const bytes = await readFile(asset[0]);
      res.writeHead(200, { "Content-Type": asset[1] });
      res.end(bytes);
    } catch (error) {
      if (error instanceof FundingError)
        return json(
          res,
          ["CASE_NOT_FOUND", "RESEARCH_NOT_FOUND"].includes(error.code)
            ? 404
            : [
                  "RESEARCH_BUSY",
                  "RESEARCH_CONFLICT",
                  "RESEARCH_NOT_COMPLETE",
                  "RESEARCH_SESSION_LIMIT",
                ].includes(error.code)
              ? 409
              : 400,
          {
            error: error.message,
            code: error.code,
          },
        );
      if (error instanceof z.ZodError)
        return json(res, 400, {
          error: "Enter one startup description of 15–1,000 characters.",
        });
      return json(res, 500, {
        error:
          "The request could not be completed. Check an existing investigation's status before starting another; no automatic retry was made.",
      });
    }
  });
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const port = Number(process.env.FUNDING_RADAR_PORT ?? 4391);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Choose a local port from 1024 to 65535.");
  createFundingServer().listen(port, "127.0.0.1", () =>
    process.stdout.write(
      "Funding Radar: http://127.0.0.1:" +
        port +
        " (saved research; live dispatch requires explicit operator configuration)\n",
    ),
  );
}
