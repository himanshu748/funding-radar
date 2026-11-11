import {
  observeTinySetRequests,
  type ProviderObservation,
} from "./provider-observer.js";
import { TinySetClient } from "../../providers/tinyset.js";
import {
  planRecentFunding,
  rankRecentCompanies,
  type RecentCollection,
} from "./recent.js";

/** One explicit >=10-row company-round run; no retries or separate allowance. */
export async function researchRecentFunding(
  description: string,
  input: {
    requestId: string;
    policyId: string;
    lookbackMonths?: 12 | 18;
    targetRows?: number;
    signal?: AbortSignal;
    onProviderEvent?: (event: Readonly<ProviderObservation>) => void;
  },
) {
  const plan = planRecentFunding(description, {
    lookbackMonths: input.lookbackMonths ?? 18,
    targetRows: input.targetRows ?? 10,
  });
  const client = await TinySetClient.fromEnvironment({
    request: observeTinySetRequests(fetch, input.onProviderEvent ?? (() => {})),
  });
  const transport = await client.run({
    requestId: input.requestId,
    bountyId: "funding-radar",
    policyId: input.policyId,
    spec: plan.body.spec,
    targetRows: plan.body.target_rows,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const observations: RecentCollection = {
    format: "funding-radar-rounds-v2",
    mode: "saved_live",
    dataset_id: transport.dataset_id,
    run_id: transport.run_id,
    collected_at: transport.checked_at,
    as_of: plan.window.as_of,
    lookback_months: plan.window.months,
    rows: transport.rows.map((row) => ({ _id: row.id, data: row.data })),
  };
  return {
    observations,
    report: rankRecentCompanies(description, observations),
    transport,
  };
}
