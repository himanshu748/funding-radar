import test from "node:test";
import assert from "node:assert/strict";
import {
  observeTinySetRequests,
  type ProviderObservation,
} from "../src/provider-observer.js";
test("a rejected create preserves status and phase without logging its key, body or URL", async () => {
  const events: ProviderObservation[] = [];
  let calls = 0;
  const request = observeTinySetRequests(
    (async () => {
      calls++;
      return new Response('{"error":"fake-sensitive-body"}', { status: 422 });
    }) as typeof fetch,
    (event) => events.push(event),
  );
  const response = await request("https://agent.tinyfish.ai/v1/datasets", {
    method: "POST",
    headers: { "X-API-Key": "synthetic-private-key" },
    body: '{"private":"synthetic-private-value"}',
  });
  assert.equal(response.status, 422);
  assert.equal(calls, 1);
  assert.deepEqual(events, [
    {
      phase: "dataset_create",
      method: "POST",
      http_status: 422,
      outcome: "response",
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(events),
    /synthetic|sensitive|https|private/,
  );
});
test("network failure stays distinguishable from an HTTP response and is never retried", async () => {
  const events: ProviderObservation[] = [];
  let calls = 0;
  const expected = new Error("synthetic network failure");
  const request = observeTinySetRequests(
    (async () => {
      calls++;
      throw expected;
    }) as typeof fetch,
    (event) => events.push(event),
  );
  await assert.rejects(
    request("https://agent.tinyfish.ai/v1/datasets", { method: "POST" }),
    (error) => error === expected,
  );
  assert.equal(calls, 1);
  assert.equal(events[0]!.http_status, null);
  assert.equal(events[0]!.outcome, "network_failure");
});
test("observer exceptions do not replace successful transport results", async () => {
  const request = observeTinySetRequests(
    (async () => new Response("ok", { status: 201 })) as typeof fetch,
    () => {
      throw new Error("logger failed");
    },
  );
  assert.equal(
    (await request("https://agent.tinyfish.ai/v1/datasets", { method: "POST" }))
      .status,
    201,
  );
});
test("non-provider destinations are refused before sending any headers", async () => {
  let calls = 0;
  const request = observeTinySetRequests(
    (async () => {
      calls++;
      return new Response();
    }) as typeof fetch,
    () => {},
  );
  await assert.rejects(
    request("https://attacker.example/v1/datasets", {
      headers: { "X-API-Key": "synthetic-only" },
    }),
  );
  assert.equal(calls, 0);
});
test("wallet, fill and row reads are classified without exposing object IDs or responses", async () => {
  const events: ProviderObservation[] = [];
  const request = observeTinySetRequests(
    (async () => new Response("ok")) as typeof fetch,
    (event) => events.push(event),
  );
  await request("https://agent.tinyfish.ai/v1/wallet");
  await request(
    "https://agent.tinyfish.ai/v1/datasets/synthetic-object-id/populate",
    { method: "POST" },
  );
  await request(
    "https://agent.tinyfish.ai/v1/datasets/synthetic-object-id/rows?limit=10",
  );
  assert.deepEqual(
    events.map((e) => e.phase),
    ["wallet_pricing", "dataset_fill", "rows_read"],
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /synthetic-object-id|balance|limit/,
  );
});

test("an aborted Request input is classified without requiring a duplicate init.signal", async () => {
  const controller = new AbortController();
  const input = new Request("https://agent.tinyfish.ai/v1/datasets", {
    method: "POST",
    signal: controller.signal,
  });
  controller.abort();
  const events: ProviderObservation[] = [];
  const request = observeTinySetRequests(
    (async () => {
      throw new DOMException("Synthetic abort", "AbortError");
    }) as typeof fetch,
    (event) => events.push(event),
  );
  await assert.rejects(request(input));
  assert.equal(events[0]!.outcome, "aborted");
  assert.equal(events[0]!.http_status, null);
});
test("a rejected asynchronous observer cannot turn transport success into a process error", async () => {
  const request = observeTinySetRequests(
    (async () => new Response("ok", { status: 201 })) as typeof fetch,
    async () => {
      throw new Error("Synthetic async logger failure");
    },
  );
  assert.equal(
    (await request("https://agent.tinyfish.ai/v1/datasets", { method: "POST" }))
      .status,
    201,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
});
