import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { FundingError } from "./core.js";
import {
  parseRecentObservations,
  rankRecentCompanies,
  type RecentCollection,
} from "./recent.js";
import { buildReviewedCase, sha256 } from "./review.js";
import { rankReviewedInvestors } from "./reviewed-ranking.js";

const maximumBytes = 2 * 1024 * 1024;
const timestamp = z.iso.datetime();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// Strip export-only fields, provider reports and transport headers. Row data is
// retained as original provider evidence, not interpreted as trusted review.
const transportSchema = z.object({
  dataset_id: z.uuid(),
  run_id: z.uuid(),
  checked_at: timestamp,
  target_rows: z.number().int().min(10).max(20),
  row_count: z.number().int().nonnegative().max(20),
  status: z.literal("ready"),
  rows: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        data: z.record(z.string(), z.unknown()),
      }),
    )
    .max(20),
  reservation_microusd: count,
  estimated_row_cost_microusd: count,
  cost_note: z.string().min(1).max(2000),
});
const recordingSchema = z.object({
  format: z.literal("funding-radar-reviewed-case-v1"),
  id: z.uuid(),
  description: z.string().min(15).max(1000),
  collection_mode: z.literal("saved_live").optional(),
  mode: z
    .enum([
      "saved_live_review_pending",
      "saved_live_with_separate_source_review",
    ])
    .optional(),
  original: z.object({
    dataset_id: z.uuid(),
    run_id: z.uuid(),
    collected_at: timestamp,
    observations_sha256: digest,
  }),
  provider_result: z.object({
    observations: z.unknown(),
    transport: transportSchema,
  }),
});

function invalid(message: string): never {
  throw new FundingError("INVALID_RECORDING", message);
}

/**
 * Replay a completed saved TinySet export entirely in memory. This validates
 * internal provenance consistency, not remote authenticity or source truth.
 * Source review and investor ranking are optional, separately bound layers.
 * No environment, filesystem, network, account or provider access occurs.
 */
export function buildRecordedInvestigation(
  sourceBytes: Buffer,
  label: string,
  reviewValue?: unknown,
  rankingValue?: unknown,
) {
  if (
    !Buffer.isBuffer(sourceBytes) ||
    sourceBytes.length === 0 ||
    sourceBytes.length > maximumBytes
  )
    invalid("Use a nonempty recorded export no larger than 2 MiB.");
  if (
    typeof label !== "string" ||
    label.trim().length === 0 ||
    label.length > 200
  )
    invalid("Use a recorded investigation label of 1–200 characters.");

  let value: unknown;
  try {
    value = JSON.parse(sourceBytes.toString("utf8"));
  } catch {
    invalid("The recorded export must contain valid JSON.");
  }
  const parsed = recordingSchema.safeParse(value);
  if (!parsed.success)
    invalid("The export must describe a completed, bounded saved live result.");
  const source = parsed.data;
  const validated = parseRecentObservations(
    source.provider_result.observations,
  );
  if (
    validated.mode !== "saved_live" ||
    !isDeepStrictEqual(validated, source.provider_result.observations)
  )
    invalid(
      "Only unchanged, versioned saved live observations can be replayed.",
    );

  // Preserve original observation key order: the receipt hashes JSON.stringify
  // of that exact object, rather than a schema-reordered reconstruction.
  const observations = source.provider_result.observations as RecentCollection;
  const observationBytes = Buffer.from(JSON.stringify(observations));
  const transport = source.provider_result.transport;
  if (
    source.original.observations_sha256 !== sha256(observationBytes) ||
    source.original.dataset_id !== observations.dataset_id ||
    source.original.run_id !== observations.run_id ||
    source.original.collected_at !== observations.collected_at ||
    transport.dataset_id !== observations.dataset_id ||
    transport.run_id !== observations.run_id ||
    transport.checked_at !== observations.collected_at
  )
    invalid(
      "Recorded identities, collection time and observation digest must agree.",
    );
  if (
    transport.row_count > transport.target_rows ||
    transport.row_count !== observations.rows.length ||
    transport.row_count !== transport.rows.length ||
    new Set(transport.rows.map((row) => row.id)).size !==
      transport.rows.length ||
    !transport.rows.every(
      (row, index) =>
        row.id === observations.rows[index]!._id &&
        isDeepStrictEqual(row.data, observations.rows[index]!.data),
    )
  )
    invalid(
      "Recorded row counts, unique identities and original row data must agree.",
    );

  // Recompute both layers. Never trust reports, review claims, scores or ready
  // flags copied from the downloaded envelope. This also rejects future or
  // internally inconsistent observation timestamps through the existing gate.
  const report = rankRecentCompanies(source.description, observations);
  let reviewed: ReturnType<typeof buildReviewedCase>;
  try {
    reviewed = buildReviewedCase(
      source.description,
      observationBytes,
      reviewValue,
    );
  } catch (error) {
    if (error instanceof FundingError) throw error;
    invalid("The optional source review is not a valid bound review.");
  }
  if (
    reviewed.review &&
    Date.parse(reviewed.review.checked_at) <
      Date.parse(observations.collected_at)
  )
    throw new FundingError(
      "REVIEW_TIME_INVALID",
      "A source review must follow the recorded research collection.",
    );

  let shortlist: ReturnType<typeof rankReviewedInvestors> | undefined;
  if (rankingValue !== undefined) {
    try {
      shortlist = rankReviewedInvestors(reviewed, rankingValue);
    } catch (error) {
      if (error instanceof FundingError) throw error;
      invalid("The optional investor ranking is not a valid bound review.");
    }
  }
  return {
    ...reviewed,
    id: source.id,
    label: label.trim(),
    export_base: `/api/investigation/${source.id}`,
    provider_result: { observations, report, transport },
    result_origin: "recorded_live" as const,
    recording: {
      source_export_sha256: sha256(sourceBytes),
      collected_at: observations.collected_at,
    },
    ...(shortlist ? { reviewed_shortlist: shortlist } : {}),
    approach_ready_investors: shortlist
      ? shortlist.investors.filter((investor) => investor.approach_ready)
      : reviewed.approach_ready_investors,
    submission_ready: false as const,
  };
}
