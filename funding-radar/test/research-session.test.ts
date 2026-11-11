import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TinySetError } from "../../providers/tinyset.js";
import { ProviderError } from "../../providers/pricing.js";
import { ControlError } from "../../shared/errors.js";
import { FundingError } from "../src/core.js";
import {
  FundingResearchSessions,
  type FundingResearchStatus,
} from "../src/research-session.js";
import type { researchRecentFunding } from "../src/recent-live.js";
import { rankRecentCompanies, type RecentCollection } from "../src/recent.js";
import { sha256 } from "../src/review.js";

type ResearchOutput = Awaited<ReturnType<typeof researchRecentFunding>>;
type ResearchInput = Parameters<typeof researchRecentFunding>[1];
const description =
  "Seed aquaculture sensors that predict shrimp disease for farms in Vietnam";
const policyId = "funding-radar-authorized-attempt";
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(text = description, targetRows = 20): ResearchOutput {
  const observations: RecentCollection = {
    format: "funding-radar-rounds-v2",
    mode: "synthetic_fixture",
    dataset_id: "11111111-1111-4111-8111-111111111111",
    run_id: "22222222-2222-4222-8222-222222222222",
    collected_at: "2026-11-08T00:00:00.000Z",
    as_of: "2026-11-08",
    lookback_months: 18,
    rows: [
      {
        _id: "synthetic-company-round-1",
        data: {
          company_name: "Synthetic Aquaculture Tools",
          company_url: "https://example.com/aquaculture",
          announced_on: "2026-10-01",
          round_stage: "Seed",
          geography: "Vietnam",
          sector: "aquaculture disease sensors",
          similarity_reason: "Predicts disease for shrimp farms in Vietnam.",
          investor_name: "Synthetic Research Capital",
          investor_url: "https://example.com/investor",
          evidence_url: "https://example.com/aquaculture/seed",
          evidence_summary:
            "Synthetic Aquaculture Tools raised Seed funding from Synthetic Research Capital on 2026-10-01 for aquaculture disease sensors. Synthetic unit-test evidence only.",
        },
      },
    ],
  };
  return {
    observations,
    report: rankRecentCompanies(text, observations),
    transport: {
      dataset_id: observations.dataset_id,
      run_id: observations.run_id,
      checked_at: observations.collected_at,
      target_rows: targetRows,
      row_count: observations.rows.length,
      status: "ready",
      rows: observations.rows.map((row) => ({ id: row._id, data: row.data })),
      reservation_microusd: 0,
      estimated_row_cost_microusd: 0,
      cost_note: "Injected synthetic unit-test transport; no provider call.",
    },
  };
}

function code(expected: string) {
  return (error: unknown) =>
    error instanceof FundingError && error.code === expected;
}

async function settled(
  sessions: FundingResearchSessions,
  id: string,
): Promise<FundingResearchStatus> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const status = sessions.get(id);
    if (status.status !== "running") return status;
    await turn();
  }
  assert.fail("Injected unit-test research did not settle.");
}

test("an unseen full description and exact default bound reach one injected task, with raw provenance retained", async () => {
  const pending = deferred<ResearchOutput>();
  const calls: { text: string; input: ResearchInput }[] = [];
  const sessions = new FundingResearchSessions({
    policyId,
    research: async (text, input) => {
      calls.push({ text, input });
      return pending.promise;
    },
  });
  const full = "  " + description + "; niche = brackish-water nurseries  ";
  const id = randomUUID();
  assert.deepEqual(sessions.start({ description: full, request_id: id }), {
    request_id: id,
    status: "running",
    status_url: `/api/research/${id}`,
  });
  assert.equal(calls.length, 0, "start returns before dispatch");
  await turn();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.text, full);
  assert.equal(calls[0]!.input.targetRows, 20);
  assert.equal(calls[0]!.input.policyId, policyId);
  assert.equal(calls[0]!.input.requestId, id);
  assert.equal(calls[0]!.input.signal!.aborted, false);
  assert.throws(() => sessions.result(id), code("RESEARCH_NOT_COMPLETE"));
  const raw = fixture(full);
  pending.resolve(raw);
  const status = await settled(sessions, id);
  assert.equal(status.status, "complete");
  assert.equal(status.result_url, `/api/investigation/${id}`);
  const result = sessions.result(id);
  assert.equal(result.id, id);
  assert.equal(result.label, "New investigation");
  assert.equal(result.export_base, `/api/investigation/${id}`);
  assert.equal(result.description, full);
  assert.equal(result.startup.description, full);
  assert.equal(result.review, null);
  assert.equal(result.coverage.independently_reviewed_recent, 0);
  assert.equal(result.coverage.returned_by_tinyset, 1);
  assert.equal(result.submission_ready, false);
  assert.deepEqual(result.approach_ready_investors, []);
  assert.equal(result.rows[0]!.source_status, "not_reviewed");
  assert.deepEqual(
    result.rows[0]!.original_claim,
    raw.observations.rows[0]!.data,
  );
  assert.equal(
    result.original.observations_sha256,
    sha256(Buffer.from(JSON.stringify(raw.observations))),
  );
  assert.deepEqual(result.provider_result, raw);
  assert.equal(result.provider_result.observations.mode, "synthetic_fixture");
  result.provider_result.transport.cost_note = "caller mutation";
  raw.transport.cost_note = "fake producer mutation";
  assert.match(
    sessions.result(id).provider_result.transport.cost_note,
    /Injected synthetic/,
  );
});

test("an explicit row bound is forwarded and invalid configuration cannot dispatch", async () => {
  let calls = 0;
  let receivedRows: number | undefined;
  const research: typeof researchRecentFunding = async (text, input) => {
    calls++;
    receivedRows = input.targetRows;
    return fixture(text, input.targetRows);
  };
  for (const targetRows of [9, 21, 10.5, NaN])
    assert.throws(
      () => new FundingResearchSessions({ policyId, targetRows, research }),
      code("INVALID_RESEARCH_CONFIG"),
    );
  assert.throws(
    () => new FundingResearchSessions({ policyId: "bad policy", research }),
    code("INVALID_RESEARCH_CONFIG"),
  );
  assert.equal(calls, 0);
  const sessions = new FundingResearchSessions({
    policyId,
    targetRows: 12,
    research,
  });
  const id = randomUUID();
  sessions.start({ description, request_id: id });
  assert.equal((await settled(sessions, id)).status, "complete");
  assert.equal(receivedRows, 12);
  assert.equal(calls, 1);
});

test("invalid IDs, invalid descriptions and unknown sessions fail without dispatch", async () => {
  let calls = 0;
  const sessions = new FundingResearchSessions({
    policyId,
    research: async () => {
      calls++;
      return fixture();
    },
  });
  assert.throws(
    () => sessions.start({ description, request_id: "not-a-uuid" }),
    code("INVALID_REQUEST_ID"),
  );
  for (const invalid of ["short", "x".repeat(1001), description + "\nnext"])
    assert.throws(
      () => sessions.start({ description: invalid, request_id: randomUUID() }),
      code("INVALID_STARTUP"),
    );
  assert.throws(
    () =>
      sessions.start({
        description: 42 as unknown as string,
        request_id: randomUUID(),
      }),
    code("INVALID_STARTUP"),
  );
  const unknown = randomUUID();
  for (const operation of ["get", "result", "cancel"] as const) {
    assert.throws(
      () => sessions[operation](unknown),
      code("RESEARCH_NOT_FOUND"),
    );
    assert.throws(
      () => sessions[operation]("bad-id"),
      code("INVALID_REQUEST_ID"),
    );
  }
  await turn();
  assert.equal(calls, 0);
});

test("same UUID and exact description are idempotent before and after completion; changed text conflicts", async () => {
  const pending = deferred<ResearchOutput>();
  let calls = 0;
  const sessions = new FundingResearchSessions({
    policyId,
    research: async () => {
      calls++;
      return pending.promise;
    },
  });
  const id = randomUUID();
  const first = sessions.start({ description, request_id: id.toUpperCase() });
  assert.equal(first.request_id, id);
  assert.deepEqual(sessions.start({ description, request_id: id }), first);
  assert.throws(
    () => sessions.start({ description: description + " ", request_id: id }),
    code("RESEARCH_CONFLICT"),
  );
  assert.throws(
    () => sessions.start({ description: "changed", request_id: id }),
    code("RESEARCH_CONFLICT"),
  );
  await turn();
  assert.equal(calls, 1);
  pending.resolve(fixture());
  const done = await settled(sessions, id);
  assert.deepEqual(sessions.start({ description, request_id: id }), done);
  assert.equal(calls, 1);
});

test("a different active job is rejected and settled work releases the local concurrency slot", async () => {
  const pending = deferred<ResearchOutput>();
  let calls = 0;
  let active = 0;
  let peak = 0;
  const sessions = new FundingResearchSessions({
    policyId,
    research: async (text) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      try {
        return calls === 1 ? await pending.promise : fixture(text);
      } finally {
        active--;
      }
    },
  });
  const first = randomUUID();
  const second = randomUUID();
  sessions.start({ description, request_id: first });
  assert.throws(
    () => sessions.start({ description, request_id: second }),
    code("RESEARCH_BUSY"),
  );
  await turn();
  assert.equal(calls, 1);
  pending.resolve(fixture());
  await settled(sessions, first);
  sessions.start({ description, request_id: second });
  await settled(sessions, second);
  assert.equal(calls, 2);
  assert.equal(peak, 1);
});

test("twenty retained jobs are bounded without eviction or automatic repeat", async () => {
  let calls = 0;
  const sessions = new FundingResearchSessions({
    policyId,
    research: async () => {
      calls++;
      return fixture();
    },
  });
  const ids = Array.from({ length: 20 }, () => randomUUID());
  for (const id of ids) {
    sessions.start({ description, request_id: id });
    await settled(sessions, id);
  }
  assert.equal(calls, 20);
  assert.throws(
    () => sessions.start({ description, request_id: randomUUID() }),
    code("RESEARCH_SESSION_LIMIT"),
  );
  assert.equal(
    sessions.start({ description, request_id: ids[0]! }).status,
    "complete",
  );
  assert.equal(calls, 20);
});

test("unknown failures are redacted and retained failed IDs never retry", async () => {
  let calls = 0;
  const secret = "synthetic-private-key-and-provider-body";
  const sessions = new FundingResearchSessions({
    policyId,
    research: async () => {
      calls++;
      throw Object.assign(new Error(secret), {
        code: "FAKE_TRUSTED_CODE",
        authorization: secret,
      });
    },
  });
  const id = randomUUID();
  sessions.start({ description, request_id: id });
  const failed = await settled(sessions, id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error!.code, "RESEARCH_FAILED");
  assert.doesNotMatch(
    JSON.stringify(failed),
    /synthetic|FAKE_TRUSTED_CODE|stack/,
  );
  assert.deepEqual(sessions.start({ description, request_id: id }), failed);
  assert.deepEqual(sessions.cancel(id), failed);
  assert.throws(() => sessions.result(id), code("RESEARCH_NOT_COMPLETE"));
  await turn();
  assert.equal(calls, 1);
});

for (const ErrorType of [
  TinySetError,
  FundingError,
  ProviderError,
  ControlError,
])
  test(`${ErrorType.name} exposes only its public code and message`, async () => {
    const error = Object.assign(
      new ErrorType("PROVIDER_FAILURE", "Safe failure."),
      {
        provider_body: "synthetic-private-body",
        key: "synthetic-private-key",
      },
    );
    const sessions = new FundingResearchSessions({
      policyId,
      research: async () => {
        throw error;
      },
    });
    const id = randomUUID();
    sessions.start({ description, request_id: id });
    const failed = await settled(sessions, id);
    assert.deepEqual(failed.error, {
      code: "PROVIDER_FAILURE",
      message: "Safe failure.",
    });
    assert.doesNotMatch(
      JSON.stringify(failed),
      /synthetic|provider_body|stack/,
    );
    failed.error!.message = "caller mutation";
    assert.equal(sessions.get(id).error!.message, "Safe failure.");
  });

test("cancel requests a single abort, waits for settlement and fences uncertain remote termination", async () => {
  const pending = deferred<ResearchOutput>();
  let aborts = 0;
  let calls = 0;
  const sessions = new FundingResearchSessions({
    policyId,
    research: async (_text, input) => {
      calls++;
      input.signal!.addEventListener("abort", () => aborts++);
      return pending.promise;
    },
  });
  const id = randomUUID();
  sessions.start({ description, request_id: id });
  await turn();
  const cancelling = sessions.cancel(id);
  assert.equal(cancelling.status, "running");
  assert.equal(cancelling.cancellation_requested, true);
  assert.equal(cancelling.error, undefined);
  assert.deepEqual(sessions.cancel(id), cancelling);
  assert.equal(aborts, 1);
  assert.throws(
    () => sessions.start({ description, request_id: randomUUID() }),
    code("RESEARCH_BUSY"),
  );
  pending.reject(
    new TinySetError(
      "REMOTE_STATE_UNCERTAIN",
      "Remote termination could not be verified; the existing grant remains fenced.",
    ),
  );
  const failed = await settled(sessions, id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.cancellation_requested, true);
  assert.equal(failed.error!.code, "REMOTE_STATE_UNCERTAIN");
  assert.equal("result_url" in failed, false);
  assert.throws(
    () => sessions.start({ description, request_id: randomUUID() }),
    code("RESEARCH_BUSY"),
  );
  assert.equal(calls, 1);
});

test("a completed provider result wins an abort race without a false cancellation claim", async () => {
  const pending = deferred<ResearchOutput>();
  const sessions = new FundingResearchSessions({
    policyId,
    research: async () => pending.promise,
  });
  const id = randomUUID();
  sessions.start({ description, request_id: id });
  await turn();
  sessions.cancel(id);
  pending.resolve(fixture());
  const completed = await settled(sessions, id);
  assert.equal(completed.status, "complete");
  assert.equal(completed.cancellation_requested, true);
  assert.equal(completed.error, undefined);
  assert.ok(completed.result_url);
  assert.equal(
    sessions.result(id).original.dataset_id,
    fixture().transport.dataset_id,
  );
  assert.deepEqual(sessions.cancel(id), completed);
});

test("settled library cancellation releases the slot without retrying the cancelled ID", async () => {
  let calls = 0;
  const sessions = new FundingResearchSessions({
    policyId,
    research: async (_text, input) => {
      calls++;
      if (calls > 1) return fixture();
      return new Promise<ResearchOutput>((_resolve, reject) => {
        input.signal!.addEventListener("abort", () =>
          reject(new TinySetError("CANCELLED", "TinySet operation stopped.")),
        );
      });
    },
  });
  const id = randomUUID();
  sessions.start({ description, request_id: id });
  await turn();
  sessions.cancel(id);
  const failed = await settled(sessions, id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.cancellation_requested, true);
  assert.equal(failed.error!.code, "CANCELLED");
  assert.deepEqual(sessions.start({ description, request_id: id }), failed);
  const next = randomUUID();
  sessions.start({ description, request_id: next });
  assert.equal((await settled(sessions, next)).status, "complete");
  assert.equal(calls, 2);
});

test("cancellation before dispatch starts no injected task or remote claim", async () => {
  let calls = 0;
  const sessions = new FundingResearchSessions({
    policyId,
    research: async () => {
      calls++;
      return fixture();
    },
  });
  const id = randomUUID();
  sessions.start({ description, request_id: id });
  sessions.cancel(id);
  const failed = await settled(sessions, id);
  assert.equal(calls, 0);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error!.code, "RESEARCH_STOPPED_BEFORE_DISPATCH");
  assert.equal(failed.cancellation_requested, true);
});

test("invalid returned provenance fails instead of publishing a completed investigation", async () => {
  const invalid = fixture();
  invalid.observations.dataset_id = "invalid-provider-id";
  const sessions = new FundingResearchSessions({
    policyId,
    research: async () => invalid,
  });
  const id = randomUUID();
  sessions.start({ description, request_id: id });
  const failed = await settled(sessions, id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error!.code, "INVALID_OBSERVATIONS");
  assert.equal(failed.result_url, undefined);
  assert.throws(() => sessions.result(id), code("RESEARCH_NOT_COMPLETE"));
});
