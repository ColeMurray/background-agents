import { DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS } from "@open-inspect/shared";
import { SessionIndexStore, type ChildAdmissionLease } from "../db/session-index";
import { createLogger } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import { resolveSandboxSettings } from "../session/integration-settings-resolution";
import type { SessionRouteContext } from "./session-route";
import { error } from "./shared";

const logger = createLogger("router:session-child-follow-up");

type ChildFollowUpCoordinatorContext = Pick<
  SessionRouteContext,
  "db" | "sessionRuntime" | "executionCtx" | "request_id" | "trace_id"
>;

interface ChildFollowUpRequest {
  parentId: string;
  childId: string;
  content: string;
}

/** Coordinate parent-side admission and delivery to the child Durable Object. */
export async function coordinateChildFollowUp(
  request: ChildFollowUpRequest,
  ctx: ChildFollowUpCoordinatorContext
): Promise<Response> {
  const { parentId, childId, content } = request;
  const sessionStore = new SessionIndexStore(ctx.db);
  const childSession = await sessionStore.get(childId);
  if (!childSession || childSession.parentSessionId !== parentId) {
    return error("Child session not found", 404);
  }

  let admissionLease: ChildAdmissionLease | null = null;
  if (childSession.status === "completed" || childSession.status === "failed") {
    const parentSession = await sessionStore.get(parentId);
    if (!parentSession) return error("Parent session not found", 404);

    const parentSettings = await resolveSandboxSettings(
      ctx.db,
      parentSession.repoOwner,
      parentSession.repoName,
      parentSession.environmentId
    );
    const maxConcurrentChildren =
      parentSettings.maxConcurrentChildSessions ?? DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS;
    admissionLease = await sessionStore.acquireChildAdmissionLease(
      parentId,
      childId,
      maxConcurrentChildren
    );
    if (!admissionLease) {
      return error(`Maximum concurrent children (${maxConcurrentChildren}) reached`, 429);
    }
  }

  let response: Response;
  try {
    response = await ctx.sessionRuntime.fetch(childId, SessionInternalPaths.parentPrompt, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentSessionId: parentId, content }),
    });
  } catch (fetchError) {
    if (admissionLease) await sessionStore.releaseChildAdmissionLease(admissionLease);
    throw fetchError;
  }

  if (!response.ok) {
    if (admissionLease) await sessionStore.releaseChildAdmissionLease(admissionLease);
    logger.warn("session.child_prompt", {
      event: "session.child_prompt",
      outcome: "rejected",
      parent_id: parentId,
      child_id: childId,
      http_status: response.status,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return response;
  }

  let messageId: string | undefined;
  try {
    const payload = (await response.clone().json()) as { messageId?: unknown };
    if (typeof payload.messageId === "string") messageId = payload.messageId;
  } catch {
    // The child response remains authoritative; logging is best-effort.
  }
  logger.info("session.child_prompt", {
    event: "session.child_prompt",
    outcome: "accepted",
    parent_id: parentId,
    child_id: childId,
    message_id: messageId,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  ctx.executionCtx?.waitUntil(
    sessionStore.touchUpdatedAt(childId).catch((touchError) => {
      logger.error("session_index.touch_updated_at.background_error", {
        parent_id: parentId,
        child_id: childId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
        error: touchError,
      });
    })
  );

  return response;
}
