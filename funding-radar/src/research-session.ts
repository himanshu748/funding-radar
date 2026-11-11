import { z } from "zod";
import { TinySetError } from "../../providers/tinyset.js";
import { ProviderError } from "../../providers/pricing.js";
import { FundingError } from "./core.js";
import { planRecentFunding } from "./recent.js";
import { researchRecentFunding } from "./recent-live.js";
import { buildReviewedCase } from "./review.js";
import { ControlError } from "../../shared/errors.js";
import type { ProviderObservation } from "./provider-observer.js";

type ResearchOutput = Awaited<ReturnType<typeof researchRecentFunding>>;

export interface FundingResearchStatus {
  request_id: string;
  status: "running" | "complete" | "failed";
  status_url: string;
  result_url?: string;
  cancellation_requested?: true;
  error?: { code: string; message: string };
}

export type FundingResearchInvestigation = ReturnType<
  typeof buildReviewedCase
> & {
  id: string;
  label: "New investigation";
  export_base: string;
  /** Raw library output is distinct from independently reviewed evidence. */
  provider_result: ResearchOutput;
};

interface Session {
  requestId: string;
  description: string;
  controller: AbortController;
  status: FundingResearchStatus["status"];
  cancellationRequested: boolean;
  investigation?: FundingResearchInvestigation;
  error?: FundingResearchStatus["error"];
}

function requestId(value: unknown): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success)
    throw new FundingError(
      "INVALID_REQUEST_ID",
      "Use a valid UUID for the research request.",
    );
  return parsed.data.toLowerCase();
}

function publicError(
  error: unknown,
): NonNullable<FundingResearchStatus["error"]> {
  if (
    (error instanceof TinySetError ||
      error instanceof FundingError ||
      error instanceof ControlError ||
      error instanceof ProviderError) &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) &&
    typeof error.message === "string"
  )
    return { code: error.code, message: error.message };
  return {
    code: "RESEARCH_FAILED",
    message:
      "Research could not be completed. No automatic retry was made; private error details were withheld.",
  };
}

/**
 * In-memory, bounded orchestration around the existing budget-guarded library.
 * start/get/cancel return public status immediately; result returns a completed
 * loadCase-shaped investigation or throws RESEARCH_NOT_COMPLETE. Same-ID
 * requests are idempotent only within this instance. Nothing is persisted.
 */
export class FundingResearchSessions {
  readonly #policyId: string;
  readonly #targetRows: number;
  readonly #research: typeof researchRecentFunding;
  readonly #onProviderEvent:
    ((event: Readonly<ProviderObservation>) => void) | undefined;
  readonly #sessions = new Map<string, Session>();
  #activeId: string | undefined;

  constructor(options: {
    policyId: string;
    targetRows?: number;
    research?: typeof researchRecentFunding;
    onProviderEvent?: (event: Readonly<ProviderObservation>) => void;
  }) {
    const policy = z
      .string()
      .regex(/^[a-z][a-z0-9._-]{1,63}$/)
      .safeParse(options?.policyId);
    const targetRows = options?.targetRows ?? 20;
    if (
      !policy.success ||
      !Number.isInteger(targetRows) ||
      targetRows < 10 ||
      targetRows > 20 ||
      (options.research !== undefined && typeof options.research !== "function")
    )
      throw new FundingError(
        "INVALID_RESEARCH_CONFIG",
        "Use an explicit policy ID and an exact research bound of 10–20 rows.",
      );
    this.#policyId = policy.data;
    this.#targetRows = targetRows;
    this.#research = options.research ?? researchRecentFunding;
    this.#onProviderEvent = options.onProviderEvent;
  }

  get limits() {
    return {
      target_rows: this.#targetRows,
      maximum_estimated_cost_usd: this.#targetRows * 0.1,
      price_note:
        "Paid research. The live price must remain $0.10 per row and the initialized owner grant must cover this exact row ceiling before dispatch.",
    };
  }

  start(input: {
    description: string;
    request_id: string;
  }): FundingResearchStatus {
    const id = requestId(input?.request_id);
    if (typeof input?.description !== "string")
      throw new FundingError(
        "INVALID_STARTUP",
        "Describe the startup in one line of 15–1000 characters.",
      );
    const description = input.description;
    const existing = this.#sessions.get(id);
    if (existing) {
      if (existing.description !== description)
        throw new FundingError(
          "RESEARCH_CONFLICT",
          "This request ID already belongs to a different startup description.",
        );
      return this.#publicStatus(existing);
    }
    planRecentFunding(description, { targetRows: this.#targetRows });
    if (this.#activeId)
      throw new FundingError(
        "RESEARCH_BUSY",
        "Another investigation is running or its remote state is unresolved.",
      );
    if (this.#sessions.size >= 20)
      throw new FundingError(
        "RESEARCH_SESSION_LIMIT",
        "This in-memory workspace has retained its maximum of 20 investigations.",
      );
    const session: Session = {
      requestId: id,
      description,
      controller: new AbortController(),
      status: "running",
      cancellationRequested: false,
    };
    this.#sessions.set(id, session);
    this.#activeId = id;
    // Dispatch after the synchronous status response, exactly once for this ID.
    void Promise.resolve().then(() => this.#execute(session));
    return this.#publicStatus(session);
  }

  get(id: string): FundingResearchStatus {
    return this.#publicStatus(this.#find(id));
  }

  result(id: string): FundingResearchInvestigation {
    const session = this.#find(id);
    if (session.status !== "complete" || !session.investigation)
      throw new FundingError(
        "RESEARCH_NOT_COMPLETE",
        "This investigation has no completed result. Check its status for progress or failure details.",
      );
    return structuredClone(session.investigation);
  }

  cancel(id: string): FundingResearchStatus {
    const session = this.#find(id);
    if (session.status === "running" && !session.cancellationRequested) {
      session.cancellationRequested = true;
      session.controller.abort();
    }
    // Aborting locally requests cancellation; the library must settle remotely.
    return this.#publicStatus(session);
  }

  #find(id: string): Session {
    const session = this.#sessions.get(requestId(id));
    if (!session)
      throw new FundingError(
        "RESEARCH_NOT_FOUND",
        "This in-memory research request was not found.",
      );
    return session;
  }

  #publicStatus(session: Session): FundingResearchStatus {
    return {
      request_id: session.requestId,
      status: session.status,
      status_url: `/api/research/${session.requestId}`,
      ...(session.status === "complete"
        ? { result_url: `/api/investigation/${session.requestId}` }
        : {}),
      ...(session.cancellationRequested
        ? { cancellation_requested: true as const }
        : {}),
      ...(session.error ? { error: { ...session.error } } : {}),
    };
  }

  async #execute(session: Session): Promise<void> {
    try {
      if (session.controller.signal.aborted)
        throw new FundingError(
          "RESEARCH_STOPPED_BEFORE_DISPATCH",
          "Research was stopped locally before provider dispatch.",
        );
      const output = await this.#research(session.description, {
        requestId: session.requestId,
        policyId: this.#policyId,
        targetRows: this.#targetRows,
        signal: session.controller.signal,
        ...(this.#onProviderEvent
          ? { onProviderEvent: this.#onProviderEvent }
          : {}),
      });
      const providerResult = structuredClone(output);
      const reviewed = buildReviewedCase(
        session.description,
        Buffer.from(JSON.stringify(providerResult.observations)),
      );
      session.investigation = {
        ...reviewed,
        id: session.requestId,
        label: "New investigation",
        export_base: `/api/investigation/${session.requestId}`,
        provider_result: providerResult,
      };
      // A successful remote result can win the race with a local abort request.
      session.status = "complete";
    } catch (error) {
      session.error = publicError(error);
      session.status = "failed";
    } finally {
      // Unknown remote termination stays fenced; another local job must not
      // overlap it. The shared grant also retains its own independent fence.
      if (
        this.#activeId === session.requestId &&
        session.error?.code !== "REMOTE_STATE_UNCERTAIN"
      )
        this.#activeId = undefined;
    }
  }
}
