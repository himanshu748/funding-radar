import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { load } from "cheerio";
import { loadControlsFromEnvironment } from "../../shared/index.js";
import { fetchHtml, FetchSourceError } from "../../providers/fetch.js";
import { publicUrl } from "../../zombie-check/src/urls.js";
const directory = process.env.FUNDING_SOURCE_AUDIT_PRIVATE_DIRECTORY;
if (
  !directory?.startsWith("/") ||
  process.env.FUNDING_SOURCE_AUDIT_AUTHORIZED !== "1"
)
  throw new Error(
    "Explicit one-time source audit authorization and a private absolute directory are required.",
  );
const urls = [
  "https://cherry.vc/news/infrastructure-investment-europe-cant-ignore",
  "https://amperon.co/newsroom/2m-seed-round",
  "https://rtp.vc/views/gokwik-series-growth-round-raise-2025",
  "https://www.generalatlantic.com/media-article/snapmint-announces-new-funding-led-by-general-atlantic-to-expand-its-emi-instalments-payments-platform/",
  "https://www.recurclub.com/blog/announcing-our-50m-series-a",
  "https://westbridgecap.com/portfolio/finbox",
  "https://www.coderabbit.ai/blog/coderabbit-series-b-60-million-quality-gates-for-code-reviews",
  "https://greptile.com/blog/series-b",
  "https://momentic.ai/blog/series-a",
  "https://coder.com/blog/90m-series-c-led-by-kkr-to-advance-secure-enterprise-ai-development",
  "https://span.app/blog/series-a",
  "https://swarmia.com/blog/series-a-funding",
  "https://sympower.net/news/pggm-invests-19m-in-sympower-to-accelerate-european-energy-flexibility",
  "https://enersee.ai/insights/late-seed-funding",
  "https://6degrees.vc/",
  "https://capaloai.com/news/capalo-ai-raises-11m-to-become-leading-optimizer",
  "https://companion.energy/insights/articles-news/companion-energy-raises-eu7-8m-to-rebuild-enterprise-energy-management-into-a-competitive-advantage-for-the-age-of-renewables",
  "https://axle.energy/blog/announcing-our-series-a",
  "https://bachatt.app/press-release",
  "https://xflowpay.com/press/xflow-raises-series-a-funding-$16-million",
].map(publicUrl);
if (new Set(urls).size !== urls.length || urls.length > 20)
  throw new Error("Source checks must be distinct and at most20.");
await mkdir(directory, { mode: 0o700 });
async function save(path: string, value: unknown) {
  const f = await open(path, "wx", 0o600);
  try {
    await f.writeFile(JSON.stringify(value, null, 2) + "\n");
    await f.sync();
  } finally {
    await f.close();
  }
  const d = await open(dirname(path), "r");
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
await save(join(directory, "manifest.json"), {
  provider: "tinyfish-fetch",
  policy_id: "fetch-public",
  max_unit_price_microusd: 0,
  max_source_operations: 20,
  urls,
  automatic_retry: false,
});
const controller = new AbortController(),
  stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const outcomes: Record<string, unknown>[] = [];
let halted = false;
try {
  for (let i = 0; i < urls.length; i++) {
    const source = urls[i]!;
    let controls: Awaited<ReturnType<typeof loadControlsFromEnvironment>>;
    for (;;) {
      controller.signal.throwIfAborted();
      try {
        controls = await loadControlsFromEnvironment();
        const state = await controls.pool.status();
        if (state.halted)
          throw Object.assign(new Error("halted"), { code: "HALTED" });
        const policy = controls.pool.getPolicy("fetch-public");
        if (policy.max_unit_price_microusd !== 0)
          throw Object.assign(new Error("price changed"), {
            code: "PRICING_CHANGED",
          });
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== "BUSY") throw error;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    await save(join(directory, `source-${i + 1}-intent.json`), {
      url: source,
      index: i + 1,
      recorded_at: new Date().toISOString(),
    });
    let dispatched = false;
    const request: typeof fetch = (input, init) => {
      const value =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (new URL(value).origin === "https://api.fetch.tinyfish.ai")
        dispatched = true;
      return fetch(input, init);
    };
    let outcome: Record<string, unknown>;
    try {
      const result = await fetchHtml({
        pool: controls!.pool,
        key: controls!.key,
        bountyId: "funding-radar",
        policyId: "fetch-public",
        url: source,
        selectors: [
          "title,meta,time,h1,h2,h3,p,li,script[type='application/ld+json']",
        ],
        assertAllowed: (url) => {
          if (publicUrl(url) !== source)
            throw new Error("Source identity changed");
        },
        signal: controller.signal,
        request,
      });
      await save(join(directory, `source-${i + 1}-private.json`), result);
      const $ = load(result.html),
        metadata = $("meta")
          .toArray()
          .map((e) => ({
            name: $(e).attr("property") ?? $(e).attr("name") ?? "",
            value: $(e).attr("content") ?? "",
          }))
          .filter((m) => /date|published|modified/i.test(m.name))
          .slice(0, 20);
      $("script,style").remove();
      const text = $("body").text().replace(/\s+/g, " ").trim();
      outcome = {
        url: source,
        index: i + 1,
        status: "fetched",
        observed_at: result.observed_at,
        reservation_id: result.reservation_id,
        text_sha256: createHash("sha256").update(text).digest("hex"),
        selected_html_bytes: Buffer.byteLength(result.html),
        metadata,
        title: $("h1").first().text().trim() || $("title").text().trim(),
        verification: "text_retrieved_not_semantically_verified",
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      outcome = {
        url: source,
        index: i + 1,
        status: "not_corroborated",
        error:
          typeof code === "string" && /^[A-Z_]+$/.test(code)
            ? code
            : "SOURCE_CHECK_FAILED",
        source_code:
          error instanceof FetchSourceError ? error.sourceCode : null,
        source_http_status:
          error instanceof FetchSourceError ? error.sourceHttpStatus : null,
        dispatched,
        automatic_retry: false,
      };
      const state = await controls!.pool.status();
      if (state.halted) {
        halted = true;
        outcome.pool_halted = true;
      }
      if (!dispatched && code === "BUSY") {
        outcome.skipped_before_dispatch = true;
      }
    }
    outcomes.push(outcome);
    await save(join(directory, `source-${i + 1}-outcome.json`), outcome);
    process.stdout.write(
      JSON.stringify({
        event: "source_checked",
        index: i + 1,
        status: outcome.status,
        error: outcome.error ?? null,
        url: source,
      }) + "\n",
    );
    if (
      halted ||
      outcome.error === "PRICING_CHANGED" ||
      outcome.error === "PRICING_UNAVAILABLE" ||
      outcome.error === "AUTHENTICATION" ||
      outcome.error === "PROVIDER_QUOTA" ||
      outcome.error === "ALLOWANCE_EXHAUSTED" ||
      (!dispatched && outcome.error && outcome.error !== "BUSY")
    )
      break;
  }
} catch (error) {
  halted = true;
  process.stderr.write(
    JSON.stringify({
      event: "source_audit_stopped",
      error: (error as { code?: string }).code ?? "AUDIT_STOPPED",
      automatic_retry: false,
    }) + "\n",
  );
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  const audit = {
    kind: "funding-source-audit-v2",
    provider: "tinyfish-fetch",
    distinct_source_checks: outcomes.length,
    max_authorized: 20,
    reservation_unit_price_microusd: 0,
    halted,
    automatic_retry: false,
    outcomes,
  };
  await save(join(directory, "audit.json"), audit);
  await save(
    join(process.cwd(), "funding-radar/evidence/source-audit-v2.json"),
    audit,
  );
  process.stdout.write(
    JSON.stringify({
      event: "source_audit_complete",
      attempts: outcomes.length,
      halted,
    }) + "\n",
  );
}
