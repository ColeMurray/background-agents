import { DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS } from "@open-inspect/shared";
import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import type { ChildAdmissionLease, SessionEntry, SessionIndexStore } from "../../db/session-index";
import { createLogger, type CorrelationContext } from "../../logger";
import { SessionInternalPaths } from "../contracts";
import type { SessionRuntimeClient } from "../runtime-client";

const logger = createLogger("session:parent-to-child-follow-up");

export type ParentToChildFollowUpErrorReason =
  | "child_not_found"
  | "parent_not_found"
  | "capacity_exhausted"
  | "session_not_promptable"
  | "queue_full"
  | "child_service_error";

export class ParentToChildFollowUpError extends Error {
  constructor(
    readonly reason: ParentToChildFollowUpErrorReason,
    message: string
  ) {
    super(message);
    this.name = "ParentToChildFollowUpError";
  }
}

export interface ParentToChildFollowUpServiceDeps {
  sessionIndex: Pick<
    SessionIndexStore,
    "get" | "acquireChildAdmissionLease" | "releaseChildAdmissionLease" | "touchUpdatedAt"
  >;
  sessionRuntime: Pick<SessionRuntimeClient, "fetch">;
  loadParentSandboxSettings: (
    parent: Pick<SessionEntry, "repoOwner" | "repoName" | "environmentId">
  ) => Promise<Pick<SandboxSettings, "maxConcurrentChildSessions">>;
  defer?: (promise: Promise<unknown>) => void;
  correlation: CorrelationContext;
}

export class ParentToChildFollowUpService {
  constructor(private readonly deps: ParentToChildFollowUpServiceDeps) {}

  async enqueue(followUp: {
    parentSessionId: string;
    childSessionId: string;
    content: string;
  }): Promise<{ messageId?: string; status: "queued" }> {
    const { parentSessionId, childSessionId, content } = followUp;
    const childSession = await this.deps.sessionIndex.get(childSessionId);
    if (!childSession || childSession.parentSessionId !== parentSessionId) {
      throw new ParentToChildFollowUpError("child_not_found", "Child session not found");
    }

    const admissionLease = await this.acquireResumeAdmission(
      parentSessionId,
      childSessionId,
      childSession
    );

    let response: Response;
    try {
      response = await this.deps.sessionRuntime.fetch(
        childSessionId,
        SessionInternalPaths.parentPrompt,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parentSessionId, content }),
        }
      );
    } catch (error) {
      await this.releaseAdmission(admissionLease);
      throw error;
    }

    if (!response.ok) {
      await this.releaseAdmission(admissionLease);
      const message = await readChildError(response);
      logger.warn("session.child_prompt", {
        event: "session.child_prompt",
        outcome: "rejected",
        parent_id: parentSessionId,
        child_id: childSessionId,
        http_status: response.status,
        request_id: this.deps.correlation.request_id,
        trace_id: this.deps.correlation.trace_id,
      });
      throw new ParentToChildFollowUpError(childRejectionReason(response.status), message);
    }

    const messageId = await readMessageId(response);
    logger.info("session.child_prompt", {
      event: "session.child_prompt",
      outcome: "accepted",
      parent_id: parentSessionId,
      child_id: childSessionId,
      message_id: messageId,
      request_id: this.deps.correlation.request_id,
      trace_id: this.deps.correlation.trace_id,
    });
    this.deps.defer?.(
      this.deps.sessionIndex.touchUpdatedAt(childSessionId).catch((error) => {
        logger.error("session_index.touch_updated_at.background_error", {
          parent_id: parentSessionId,
          child_id: childSessionId,
          request_id: this.deps.correlation.request_id,
          trace_id: this.deps.correlation.trace_id,
          error,
        });
      })
    );

    return { messageId, status: "queued" };
  }

  private async acquireResumeAdmission(
    parentSessionId: string,
    childSessionId: string,
    childSession: Pick<SessionEntry, "status">
  ): Promise<ChildAdmissionLease | null> {
    if (childSession.status !== "completed" && childSession.status !== "failed") return null;

    const parentSession = await this.deps.sessionIndex.get(parentSessionId);
    if (!parentSession) {
      throw new ParentToChildFollowUpError("parent_not_found", "Parent session not found");
    }
    const settings = await this.deps.loadParentSandboxSettings(parentSession);
    const maxConcurrentChildren =
      settings.maxConcurrentChildSessions ?? DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS;
    const lease = await this.deps.sessionIndex.acquireChildAdmissionLease(
      parentSessionId,
      childSessionId,
      maxConcurrentChildren
    );
    if (!lease) {
      throw new ParentToChildFollowUpError(
        "capacity_exhausted",
        `Maximum concurrent children (${maxConcurrentChildren}) reached`
      );
    }
    return lease;
  }

  private async releaseAdmission(lease: ChildAdmissionLease | null): Promise<void> {
    if (lease) await this.deps.sessionIndex.releaseChildAdmissionLease(lease);
  }
}

function childRejectionReason(status: number): ParentToChildFollowUpErrorReason {
  switch (status) {
    case 404:
      return "child_not_found";
    case 409:
      return "session_not_promptable";
    case 429:
      return "queue_full";
    default:
      return "child_service_error";
  }
}

async function readChildError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string") return payload.error;
  } catch {
    // Fall back to a stable error when the child violates its response contract.
  }
  return `Child follow-up failed (${response.status})`;
}

async function readMessageId(response: Response): Promise<string | undefined> {
  try {
    const payload = (await response.json()) as { messageId?: unknown };
    return typeof payload.messageId === "string" ? payload.messageId : undefined;
  } catch {
    return undefined;
  }
}
