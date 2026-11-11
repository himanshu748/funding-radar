import { TinySetClient } from "../../providers/tinyset.js";
import { planFunding, rankInvestors } from "./core.js";

/** No initialization, billing changes or retries; the shared external grant must already exist. */
export async function researchFunding(
  description: string,
  input: {
    requestId: string;
    policyId: string;
    targetRows?: number;
    signal?: AbortSignal;
  },
) {
  const plan = planFunding(description, input.targetRows ?? 5);
  const client = await TinySetClient.fromEnvironment();
  const result = await client.run({
    requestId: input.requestId,
    bountyId: "funding-radar",
    policyId: input.policyId,
    spec: plan.body.spec,
    targetRows: plan.body.target_rows,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const observations = {
    format: "funding-radar-observations-v1",
    mode: "saved_live",
    dataset_id: result.dataset_id,
    run_id: result.run_id,
    collected_at: result.checked_at,
    rows: result.rows.map((row) => ({ _id: row.id, data: row.data })),
  };
  return {
    observations,
    ranking: rankInvestors(description, observations, result.checked_at),
    transport: result,
  };
}
