import { z } from "zod";
import {
  loadControlsFromEnvironment,
  type Clock,
  type PoolLedger,
  type PrivateApiKey,
} from "../shared/index.js";
import { observePrice } from "./pricing.js";

const API = "https://agent.tinyfish.ai";
const uuid = z.uuid();
const column = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    label: z.string().min(1).max(200).optional(),
    type: z.enum(["string", "number", "boolean", "url", "date"]),
    is_primary_key: z.boolean(),
    is_unique: z.boolean().optional(),
    retrieval_hint: z.string().max(2000).optional(),
    format: z.string().max(2000).optional(),
    examples: z.array(z.string().max(2000)).max(3).optional(),
  })
  .strict();
export const TinySetSpecSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().min(10).max(15000),
    columns: z.array(column).min(1).max(64),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const keys = spec.columns.filter((c) => c.is_primary_key);
    if (
      keys.length !== 1 ||
      keys[0]?.type === "boolean" ||
      new Set(spec.columns.map((c) => c.name)).size !== spec.columns.length ||
      spec.columns.some((c) => c.is_primary_key && c.is_unique)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Use one non-boolean primary key, unique names and separate optional unique columns.",
      });
  });
export type TinySetSpec = z.infer<typeof TinySetSpecSchema>;

const runSchema = z.object({
  id: uuid,
  status: z.enum(["queued", "running", "done", "failed", "cancelled"]),
  started_at: z.string().nullish(),
  finished_at: z.string().nullish(),
});
const datasetSchema = z.object({
  id: uuid,
  status: z.enum(["empty", "populating", "ready", "failed", "cancelled"]),
  target_rows: z.number().int().min(1).max(250),
  row_count: z.number().int().nonnegative().max(1_000_000_000),
  run: runSchema.nullable(),
});
type Dataset = z.infer<typeof datasetSchema>;
export interface TinySetRow {
  id: string;
  data: Record<string, unknown>;
}
export interface TinySetResult {
  dataset_id: string;
  run_id: string;
  checked_at: string;
  target_rows: number;
  row_count: number;
  status: Dataset["status"];
  rows: TinySetRow[];
  reservation_microusd: number;
  estimated_row_cost_microusd: number;
  cost_note: string;
}
export class TinySetError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
interface Options {
  env?: NodeJS.ProcessEnv;
  request?: typeof fetch;
  clock?: Clock;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}
function terminal(dataset: Dataset): boolean {
  return (
    !!dataset.run &&
    ["done", "failed", "cancelled"].includes(dataset.run.status)
  );
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const done = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new TinySetError("CANCELLED", "TinySet operation stopped."));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** All creation/fill work is opt-in through the existing, already initialized shared grant. */
export class TinySetClient {
  private constructor(
    private readonly pool: PoolLedger,
    private readonly key: PrivateApiKey,
    private readonly request: typeof fetch,
    private readonly clock: Clock,
    private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>,
  ) {}
  static async fromEnvironment(options: Options = {}): Promise<TinySetClient> {
    const controls = await loadControlsFromEnvironment(
      options.env,
      options.clock,
    );
    return new TinySetClient(
      controls.pool,
      controls.key,
      options.request ?? fetch,
      options.clock ?? Date.now,
      options.wait ?? delay,
    );
  }
  private async json(
    path: string,
    method: "GET" | "POST",
    body: unknown,
    signal: AbortSignal,
    expected = 200,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const combined = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
    let response: Response;
    try {
      response = await this.key.withValue((value) =>
        this.request(API + path, {
          method,
          headers: { "X-API-Key": value, "Content-Type": "application/json" },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          redirect: "error",
          signal: combined,
        }),
      );
    } catch {
      throw new TinySetError(
        combined.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_FAILURE",
        "TinySet request failed; no automatic paid retry was made.",
      );
    }
    if (response.status !== expected) {
      await response.body?.cancel();
      throw new TinySetError(
        [401, 403].includes(response.status)
          ? "AUTHENTICATION"
          : [402, 429].includes(response.status)
            ? "PROVIDER_QUOTA"
            : "PROVIDER_FAILURE",
        "TinySet returned an unsupported response status; its private error body was withheld.",
      );
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new TinySetError(
        "PROVIDER_FAILURE",
        "TinySet response body is missing.",
      );
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 2_000_000) {
          await reader.cancel();
          throw new TinySetError(
            "RESPONSE_LIMIT",
            "TinySet response exceeded 2 MB.",
          );
        }
        chunks.push(part.value);
      }
    } catch (error) {
      if (error instanceof TinySetError) throw error;
      throw new TinySetError(
        "PROVIDER_FAILURE",
        "TinySet response did not complete.",
      );
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (this.key.withValue((value) => text.includes(value)))
      throw new TinySetError(
        "PROVIDER_FAILURE",
        "TinySet response contained private credential material and was withheld.",
      );
    try {
      const decoded: unknown = JSON.parse(text);
      const containsCredential = this.key.withValue((secret) => {
        const pending: unknown[] = [decoded];
        let visited = 0;
        while (pending.length) {
          if (++visited > 100000)
            throw new Error("TinySet object complexity bound");
          const value = pending.pop();
          if (typeof value === "string" && value.includes(secret)) return true;
          if (value && typeof value === "object")
            for (const [name, child] of Object.entries(value)) {
              if (name.includes(secret)) return true;
              pending.push(child);
            }
        }
        return false;
      });
      if (containsCredential)
        throw new Error("Decoded credential material withheld");
      return decoded;
    } catch {
      throw new TinySetError(
        "PROVIDER_FAILURE",
        "TinySet returned malformed JSON.",
      );
    }
  }
  private dataset(value: unknown, id?: string): Dataset {
    const parsed = datasetSchema.safeParse(value);
    if (!parsed.success || (id && parsed.data.id !== id))
      throw new TinySetError(
        "PROVIDER_CONTRACT_CHANGED",
        "TinySet dataset identity or lifecycle contract changed.",
      );
    return parsed.data;
  }
  private async snapshot(id: string, signal: AbortSignal): Promise<Dataset> {
    return this.dataset(
      await this.json(`/v1/datasets/${id}`, "GET", undefined, signal),
      id,
    );
  }
  private async rows(
    id: string,
    count: number,
    signal: AbortSignal,
  ): Promise<TinySetRow[]> {
    const result: TinySetRow[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page <= count; page++) {
      const query = new URLSearchParams({
        limit: String(Math.max(1, Math.min(count, 250))),
      });
      if (after) query.set("after", after);
      const parsed = z
        .object({
          columns: z.array(z.unknown()),
          rows: z.array(
            z.object({
              _id: z.string().min(1).max(200),
              data: z.record(z.string(), z.unknown()),
            }),
          ),
          truncated: z.boolean(),
          next_cursor: z.string().min(1).max(4096).nullable(),
        })
        .safeParse(
          await this.json(
            `/v1/datasets/${id}/rows?${query}`,
            "GET",
            undefined,
            signal,
          ),
        );
      if (!parsed.success)
        throw new TinySetError(
          "PAGINATION_CONTRACT",
          "TinySet row page shape changed.",
        );
      const current = parsed.data;
      if (current.truncated !== (current.next_cursor !== null))
        throw new TinySetError(
          "PAGINATION_CONTRACT",
          "TinySet pagination completeness is inconsistent.",
        );
      for (const row of current.rows) {
        if (ids.has(row._id) || result.length >= count)
          throw new TinySetError(
            "PAGINATION_CONTRACT",
            "TinySet repeated rows or exceeded its terminal count.",
          );
        ids.add(row._id);
        result.push({ id: row._id, data: row.data });
      }
      if (!current.next_cursor) {
        if (result.length !== count)
          throw new TinySetError(
            "PARTIAL_RESULT",
            "TinySet pages do not match its terminal row count.",
          );
        return result;
      }
      if (!current.rows.length || cursors.has(current.next_cursor))
        throw new TinySetError(
          "PAGINATION_CONTRACT",
          "TinySet cursor did not advance.",
        );
      cursors.add(current.next_cursor);
      after = current.next_cursor;
    }
    throw new TinySetError(
      "PAGINATION_LIMIT",
      "TinySet pagination exceeded its bounded page limit.",
    );
  }
  private async stop(
    id: string,
    expectedRunId: string | undefined,
  ): Promise<Dataset | undefined> {
    const signal = AbortSignal.timeout(30_000);
    try {
      let current = await this.snapshot(id, signal);
      if (!current.run || (expectedRunId && current.run.id !== expectedRunId))
        return undefined;
      const runId = current.run.id;
      if (!terminal(current)) {
        const parsed = z
          .object({ run_id: z.literal(runId), status: z.literal("cancelling") })
          .safeParse(
            await this.json(
              `/v1/datasets/${id}/runs/${runId}/cancel`,
              "POST",
              {},
              signal,
            ),
          );
        if (!parsed.success) return undefined;
      }
      for (let poll = 0; poll < 12; poll++) {
        if (current.run?.id !== runId) return undefined;
        if (terminal(current)) return current;
        await this.wait(1000, signal);
        current = await this.snapshot(id, signal);
      }
    } catch {
      /* Unconfirmed termination must halt the aggregate pool. */
    }
    return undefined;
  }
  async run(input: {
    requestId: string;
    bountyId: string;
    policyId: string;
    spec: TinySetSpec;
    targetRows: number;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<TinySetResult> {
    const validated = z
      .object({
        requestId: uuid,
        bountyId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
        policyId: z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/),
        spec: TinySetSpecSchema,
        targetRows: z.number().int().min(1).max(250),
        timeoutMs: z.number().int().min(1000).max(1_200_000).optional(),
      })
      .safeParse(input);
    if (!validated.success)
      throw new TinySetError(
        "INVALID_REQUEST",
        "TinySet request does not satisfy its bounded contract.",
      );
    const policy = this.pool.getPolicy(input.policyId);
    if (
      policy.unit !== "row" ||
      input.targetRows > policy.max_units_per_operation ||
      policy.max_units_per_operation > 250
    )
      throw new TinySetError(
        "CAP_EXCEEDED",
        "Requested rows exceed the actual shared policy bound.",
      );
    const signal = AbortSignal.any([
      input.signal ?? new AbortController().signal,
      AbortSignal.timeout(input.timeoutMs ?? 1_200_000),
    ]);
    signal.throwIfAborted();
    const pricing = await observePrice({
      key: this.key,
      policy,
      meter: { label: "TinyFish Set", per: "row" },
      signal,
      request: this.request,
    });
    if (pricing.unit_price_microusd !== 100_000)
      throw new TinySetError(
        "PRICE_CHANGED",
        "TinySet row pricing changed; review the existing grant before dispatch.",
      );
    const reservation = await this.pool.reserve(
      {
        request_id: input.requestId,
        bounty_id: input.bountyId,
        policy_id: input.policyId,
        pricing,
      },
      signal,
    );
    let datasetId: string | undefined;
    let runId: string | undefined;
    let fillDispatched = false;
    let recorded = false;
    try {
      const created = this.dataset(
        await this.json(
          "/v1/datasets",
          "POST",
          {
            spec: validated.data.spec,
            target_rows: input.targetRows,
            populate: false,
          },
          signal,
          201,
        ),
      );
      datasetId = created.id;
      await this.pool.markStarted(reservation.id, `tinyset:${datasetId}`);
      if (created.run !== null) {
        fillDispatched = true;
        runId = created.run.id;
      }
      if (
        created.run !== null ||
        created.status !== "empty" ||
        created.row_count !== 0 ||
        created.target_rows !== input.targetRows
      )
        throw new TinySetError(
          "PROVIDER_CONTRACT_CHANGED",
          "Explicit non-populating creation did not return an empty dataset.",
        );
      fillDispatched = true;
      let current = this.dataset(
        await this.json(
          `/v1/datasets/${datasetId}/populate`,
          "POST",
          {
            reset: false,
            target_rows: input.targetRows,
          },
          signal,
          202,
        ),
        datasetId,
      );
      if (!current.run)
        throw new TinySetError(
          "PROVIDER_CONTRACT_CHANGED",
          "TinySet fill did not return a run identifier.",
        );
      runId = current.run.id;
      for (let poll = 0; poll < 1200; poll++) {
        if (
          current.target_rows !== input.targetRows ||
          current.run?.id !== runId ||
          current.row_count > input.targetRows
        )
          throw new TinySetError(
            "PROVIDER_CONTRACT_CHANGED",
            "TinySet fill changed its requested row or run identity bound.",
          );
        if (terminal(current)) break;
        await this.wait(2000, signal);
        current = await this.snapshot(datasetId, signal);
      }
      if (!terminal(current))
        throw new TinySetError(
          "PROVIDER_TIMEOUT",
          "TinySet fill did not reach a terminal state.",
        );
      await this.pool.recordTerminal(
        reservation.id,
        current.run?.status === "done"
          ? "success"
          : current.run?.status === "cancelled"
            ? "cancelled"
            : "failure",
        current.row_count,
      );
      recorded = true;
      if (current.run?.status !== "done" || current.status !== "ready")
        throw new TinySetError(
          "RUN_FAILED",
          "TinySet ended without a ready result; no fixture was substituted.",
        );
      const rows = await this.rows(datasetId, current.row_count, signal);
      return {
        dataset_id: datasetId,
        run_id: runId,
        checked_at: new Date(this.clock()).toISOString(),
        target_rows: input.targetRows,
        row_count: current.row_count,
        status: current.status,
        rows,
        reservation_microusd: reservation.reserved_microusd,
        estimated_row_cost_microusd:
          current.row_count * pricing.unit_price_microusd,
        cost_note:
          "Terminal row-count estimate for this initially empty dataset; not a settled invoice. The full shared reservation remains retained.",
      };
    } catch (error) {
      if (!recorded) {
        if (!fillDispatched)
          await this.pool.recordTerminal(reservation.id, "failure", 0);
        else {
          const stopped = datasetId
            ? await this.stop(datasetId, runId)
            : undefined;
          if (stopped)
            await this.pool.recordTerminal(
              reservation.id,
              stopped.run?.status === "cancelled" ? "cancelled" : "failure",
              stopped.row_count,
            );
          else {
            await this.pool.recordUncertain(reservation.id);
            throw new TinySetError(
              "REMOTE_STATE_UNCERTAIN",
              "TinySet termination could not be confirmed. The shared pool is halted; do not retry automatically.",
            );
          }
        }
      }
      if (error instanceof TinySetError) throw error;
      throw new TinySetError(
        signal.aborted ? "CANCELLED" : "PROVIDER_FAILURE",
        "TinySet operation stopped; no paid retry or fixture replacement was made.",
      );
    }
  }
}
