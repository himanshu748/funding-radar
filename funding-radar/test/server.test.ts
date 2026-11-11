import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createFundingServer } from "../src/server.js";
import { FundingResearchSessions } from "../src/research-session.js";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { rankRecentCompanies, parseRecentObservations } from "../src/recent.js";
import { TinySetError } from "../../providers/tinyset.js";

test("recorded app journey, exports and new brief require no provider access; live dispatch remains paused", async (t) => {
  const server = createFundingServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Find the backer/);
  assert.match(
    home.headers.get("content-security-policy")!,
    /frame-ancestors 'none'/,
  );
  for (const path of [
    "/style.css",
    "/app.js",
    "/fonts/manrope.woff2",
    "/fonts/dmsans.woff2",
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  const list = await (await fetch(base + "/api/cases")).json();
  assert.equal(list.cases.length, 4);
  assert.equal(list.provider_operations_started, 0);
  assert.equal(list.fresh_research_enabled, false);
  const recording = list.cases.find(
    (entry: { id: unknown }) => typeof entry.id === "string",
  );
  assert.equal(recording.result_origin, "recorded_live");
  assert.equal(recording.coverage.returned_by_tinyset, 19);
  assert.equal(recording.coverage.independently_reviewed_recent, 17);
  const recorded = await (
    await fetch(base + "/api/investigation/" + recording.id)
  ).json();
  assert.equal(recorded.result_origin, "recorded_live");
  assert.equal(
    recorded.description,
    "US seed software startup automating security compliance evidence and vendor questionnaires for SaaS teams",
  );
  assert.equal(recorded.rows.length, 19);
  assert.equal(recorded.review.case_id, 4);
  assert.equal(recorded.approach_ready_investors.length, 0);
  const recordedStatus = await (
    await fetch(base + "/api/research/" + recording.id)
  ).json();
  assert.equal(recordedStatus.status, "complete");
  assert.equal(recordedStatus.result_origin, "recorded_live");
  assert.equal(
    (await fetch(base + "/api/investigation/" + recording.id + ".csv")).status,
    200,
  );
  for (const id of [1, 2, 3]) {
    const report = await (await fetch(base + "/api/case/" + id)).json();
    assert.equal(report.rows.length, 12);
    assert.equal(report.coverage.returned_by_tinyset, 10);
    assert.equal(report.coverage.ordinary_web_supplement_companies, 2);
    assert.equal(report.coverage.independently_reviewed_recent, 10);
    assert.equal(
      report.rows.filter(
        (row: { record_origin: string }) =>
          row.record_origin === "ordinary_web_supplement",
      ).length,
      2,
    );
    assert.equal(report.submission_ready, false);
    assert.ok(report.original.observations_sha256);
    assert.equal(report.original.run_id.length, 36);
    const json = await fetch(base + "/api/case/" + id + ".json");
    assert.match(json.headers.get("content-disposition")!, /attachment/);
    assert.equal((await json.json()).format, "funding-radar-reviewed-case-v1");
    const csv = await fetch(base + "/api/case/" + id + ".csv");
    assert.match(csv.headers.get("content-type")!, /text\/csv/);
    assert.match(await csv.text(), /review_status/);
  }
  const plan = await fetch(base + "/api/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      description:
        "France seed health software startup building radiology workflows",
    }),
  });
  assert.equal(plan.status, 200);
  const body = await plan.json();
  assert.equal(body.provider_calls, 0);
  assert.equal(body.live_dispatch_allowed, false);
  assert.equal(body.body.populate, false);
  assert.equal(body.body.target_rows, 10);
  const paused = await fetch(base + "/api/research", { method: "POST" });
  assert.equal(paused.status, 503);
  assert.equal((await paused.json()).provider_operations_started, 0);
  assert.equal(
    (
      await fetch(base + "/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "short" }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(base + "/api/plan", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "x",
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await fetch(base + "/api/plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://untrusted.example.com",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal((await fetch(base + "/.env")).status, 404);
  assert.equal((await fetch(base + "/api/case/4")).status, 404);
});

test("opt-in HTTP research is generic, idempotent, exported and explicitly unreviewed", async (t) => {
  let calls = 0;
  let actualDescription = "";
  const sessions = new FundingResearchSessions({
    policyId: "synthetic-http-test",
    targetRows: 20,
    research: async (description) => {
      calls++;
      actualDescription = description;
      const observations = parseRecentObservations(
        JSON.parse(
          await readFile(
            new URL("../evidence/recent-1-observations.json", import.meta.url),
            "utf8",
          ),
        ),
      );
      observations.mode = "synthetic_fixture"; // Reused rows in an injected transport are not a fresh provider run.
      return {
        observations,
        report: rankRecentCompanies(description, observations),
        transport: {
          dataset_id: observations.dataset_id,
          run_id: observations.run_id,
          checked_at: observations.collected_at,
          target_rows: 20,
          row_count: observations.rows.length,
          status: "ready",
          rows: observations.rows.map((r) => ({ id: r._id, data: r.data })),
          reservation_microusd: 0,
          estimated_row_cost_microusd: 0,
          cost_note: "Synthetic HTTP integration test; no provider operation.",
        },
      };
    },
  });
  const server = createFundingServer({ sessions });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const meta = await (await fetch(base + "/api/cases")).json();
  assert.equal(meta.fresh_research_enabled, true);
  assert.equal(meta.live_limits.target_rows, 20);
  assert.equal(meta.live_limits.maximum_estimated_cost_usd, 2);
  const input = {
    description:
      "Canada seed logistics software for automated customs documents",
    request_id: randomUUID(),
  };
  const post = (value: unknown, origin?: string) =>
    fetch(base + "/api/research", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify(value),
    });
  const archiveMeta = meta.cases.find(
    (entry: { id: unknown }) => typeof entry.id === "string",
  );
  const archiveResult = await (
    await fetch(base + "/api/investigation/" + archiveMeta.id)
  ).json();
  const prior = await post({
    description: archiveResult.description,
    request_id: archiveMeta.id,
  });
  assert.equal(prior.status, 202);
  assert.equal((await prior.json()).result_origin, "recorded_live");
  assert.equal(calls, 0);
  assert.equal(
    (
      await post({
        description: archiveResult.description + " changed",
        request_id: archiveMeta.id,
      })
    ).status,
    409,
  );
  assert.equal(calls, 0);
  assert.equal((await post(input, "https://untrusted.example")).status, 403);
  assert.equal(calls, 0);
  assert.equal((await post({ ...input, request_id: "bad" })).status, 400);
  assert.equal(calls, 0);
  const accepted = await post(input);
  assert.equal(accepted.status, 202);
  const status = await accepted.json();
  await post(input);
  for (let i = 0; i < 20; i++) {
    const body = await (await fetch(base + status.status_url)).json();
    if (body.status === "complete") break;
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(calls, 1);
  assert.equal(actualDescription, input.description);
  assert.equal(
    (await post({ ...input, description: input.description + " changed" }))
      .status,
    409,
  );
  const current = await (await fetch(base + status.status_url)).json();
  assert.equal(current.status, "complete");
  const data = await (await fetch(base + current.result_url)).json();
  assert.equal(data.description, input.description);
  assert.equal(data.collection_mode, "synthetic_fixture");
  assert.equal(data.mode, "synthetic_fixture_review_pending");
  assert.equal(data.coverage.independently_reviewed_recent, 0);
  assert.equal(data.submission_ready, false);
  assert.deepEqual(data.approach_ready_investors, []);
  const json = await fetch(base + current.result_url + ".json");
  assert.match(json.headers.get("content-disposition")!, /attachment/);
  const csv = await fetch(base + current.result_url + ".csv");
  assert.match(await csv.text(), /synthetic_fixture_review_pending/);
  assert.equal(
    (await fetch(base + "/api/research/" + randomUUID())).status,
    404,
  );
});

test("HTTP cancellation preserves uncertain remote state and blocks a second investigation", async (t) => {
  let calls = 0;
  const sessions = new FundingResearchSessions({
    policyId: "synthetic-http-test",
    research: async (_description, input) => {
      calls++;
      return await new Promise((_resolve, reject) =>
        input.signal!.addEventListener(
          "abort",
          () =>
            reject(
              new TinySetError(
                "REMOTE_STATE_UNCERTAIN",
                "Remote termination is not confirmed. No automatic retry.",
              ),
            ),
          { once: true },
        ),
      );
    },
  });
  const server = createFundingServer({ sessions });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const request_id = randomUUID(),
    description = "Japan seed software for factory scheduling and maintenance";
  const response = await fetch(base + "/api/research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description, request_id }),
  });
  assert.equal(response.status, 202);
  await new Promise((r) => setImmediate(r));
  const cancel = await fetch(base + `/api/research/${request_id}/cancel`, {
    method: "POST",
  });
  assert.equal(cancel.status, 202);
  assert.equal((await cancel.json()).cancellation_requested, true);
  await new Promise((r) => setImmediate(r));
  const status = await (
    await fetch(base + `/api/research/${request_id}`)
  ).json();
  assert.equal(status.status, "failed");
  assert.equal(status.error.code, "REMOTE_STATE_UNCERTAIN");
  const other = await fetch(base + "/api/research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description, request_id: randomUUID() }),
  });
  assert.equal(other.status, 409);
  assert.equal(calls, 1);
});
