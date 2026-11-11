/** Safe metadata only: no keys, headers, bodies, balances, IDs or arbitrary URLs. */
export type ProviderPhase =
  | "wallet_pricing"
  | "dataset_create"
  | "dataset_fill"
  | "dataset_read"
  | "rows_read"
  | "run_cancel"
  | "other";
export interface ProviderObservation {
  phase: ProviderPhase;
  method: string;
  http_status: number | null;
  outcome: "response" | "network_failure" | "aborted";
}
function phase(path: string, method: string): ProviderPhase {
  if (path === "/v1/wallet" && method === "GET") return "wallet_pricing";
  if (path === "/v1/datasets" && method === "POST") return "dataset_create";
  if (/^\/v1\/datasets\/[^/]+\/populate$/.test(path) && method === "POST")
    return "dataset_fill";
  if (/^\/v1\/datasets\/[^/]+\/rows$/.test(path)) return "rows_read";
  if (/^\/v1\/datasets\/[^/]+\/runs\/[^/]+\/cancel$/.test(path))
    return "run_cancel";
  if (/^\/v1\/datasets\/[^/]+$/.test(path)) return "dataset_read";
  return "other";
}
export function observeTinySetRequests(
  request: typeof fetch,
  observer: (event: Readonly<ProviderObservation>) => unknown,
): typeof fetch {
  const notify = (event: ProviderObservation) => {
    try {
      void Promise.resolve(observer(Object.freeze(event))).catch(() => {});
    } catch {
      /* Diagnostics must not change the request outcome. */
    }
  };
  return async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (
      url.origin !== "https://agent.tinyfish.ai" ||
      url.username ||
      url.password
    )
      throw new Error("Provider observer refuses an unexpected origin.");
    const rawMethod = (
      init?.method ??
      (typeof input === "object" && "method" in input ? input.method : "GET")
    ).toUpperCase();
    const method = ["GET", "POST", "HEAD", "DELETE"].includes(rawMethod)
      ? rawMethod
      : "OTHER";
    const currentPhase = phase(url.pathname, method);
    try {
      const response = await request(input, init);
      notify({
        phase: currentPhase,
        method,
        http_status: response.status,
        outcome: "response",
      });
      return response;
    } catch (error) {
      notify({
        phase: currentPhase,
        method,
        http_status: null,
        outcome: (
          init?.signal ?? (input instanceof Request ? input.signal : undefined)
        )?.aborted
          ? "aborted"
          : "network_failure",
      });
      throw error;
    }
  };
}
