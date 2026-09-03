import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  cancelChildSessionRequestSchema,
  childFollowUpPromptRequestSchema,
  sendPromptResponseSchema,
  type CancelChildSessionRequest,
} from "@open-inspect/shared/types/session-api";
import { DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS } from "@open-inspect/shared/types/integrations";
import { SessionIndexStore, type ChildAdmissionLease } from "../db/session-index";
import { createLogger } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import { resolveSandboxSettings } from "../session/integration-settings-resolution";
import { activePromptAuthorSchema } from "../session/active-prompt-author";
import type { Env } from "../types";
import {
  error,
  GITHUB_SANDBOX_FALLBACK_ROUTE,
  json,
  NO_AUTHORIZATION,
  requirePermission,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  type RequestContext,
} from "./shared";
import { type SessionRouteContext, dispatchSession } from "./session-route";

const logger = createLogger("router:session-children");

export async function handleListChildren(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const parentId = params.id;
  if (!parentId) return error("Parent session ID required");

  const sessionStore = new SessionIndexStore(ctx.db);
  const children = await sessionStore.listByParent(parentId);

  return json({ children });
}

export async function handleGetChild(
  request: Request,
  env: Env,
  params: { id: string; childId: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const parentId = params.id;
  const childId = params.childId;
  if (!parentId || !childId) return error("Parent and child session IDs required");

  const sessionStore = new SessionIndexStore(ctx.db);
  const isChild = await sessionStore.isChildOf(childId, parentId);
  if (!isChild) {
    return error("Child session not found", 404);
  }

  const url = new URL(request.url);
  return ctx.sessionRuntime.fetch(
    childId,
    SessionInternalPaths.childSummary,
    undefined,
    url.search
  );
}

export async function handlePromptChild(
  request: Request,
  _env: Env,
  params: { id: string; childId: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const parentId = params.id;
  const childId = params.childId;
  if (!parentId || !childId) return error("Parent and child session IDs required");

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return error("Invalid prompt body", 400);
  }
  const parsed = childFollowUpPromptRequestSchema.safeParse(rawBody);
  if (!parsed.success) return error("Invalid prompt body", 400);

  const sessionStore = new SessionIndexStore(ctx.db);
  const childSession = await sessionStore.get(childId);
  if (!childSession || childSession.parentSessionId !== parentId) {
    return error("Child session not found", 404);
  }

  const authorResponse = await ctx.sessionRuntime.fetch(
    parentId,
    SessionInternalPaths.activePromptAuthor
  );
  if (!authorResponse.ok) return authorResponse;
  const author = activePromptAuthorSchema.safeParse(await authorResponse.json());
  if (!author.success) return error("Failed to get active prompt author", 500);

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

  // A transport error is ambiguous: the child may have accepted the prompt before the response
  // was lost. Keep the lease until active-state finalization or its expiry rather than undercounting.
  const response = await ctx.sessionRuntime.fetch(childId, SessionInternalPaths.parentPrompt, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      parentSessionId: parentId,
      content: parsed.data.content,
      author: author.data,
    }),
  });
  if (response.ok) {
    let messageId: string | undefined;
    try {
      const parsed = sendPromptResponseSchema.safeParse(await response.clone().json());
      if (parsed.success) messageId = parsed.data.messageId;
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
    ctx.executionCtx.submit(
      () =>
        sessionStore.touchUpdatedAt(childId).catch((error) => {
          logger.error("session_index.touch_updated_at.background_error", {
            parent_id: parentId,
            child_id: childId,
            request_id: ctx.request_id,
            trace_id: ctx.trace_id,
            error,
          });
        }),
      {
        name: "session_index.touch_updated_at",
        context: {
          parent_id: parentId,
          child_id: childId,
          trace_id: ctx.trace_id,
          request_id: ctx.request_id,
        },
      }
    );
  } else {
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
  }
  return response;
}

export async function handleCancelChild(
  request: Request,
  env: Env,
  params: { id: string; childId: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const parentId = params.id;
  const childId = params.childId;
  if (!parentId || !childId) return error("Parent and child session IDs required");

  const sessionStore = new SessionIndexStore(ctx.db);
  const isChild = await sessionStore.isChildOf(childId, parentId);
  if (!isChild) {
    return error("Child session not found", 404);
  }

  // An empty body means "no options"; older clients POST without one.
  let body: CancelChildSessionRequest = {};
  const rawBody = await request.text();
  if (rawBody.trim()) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      return error("Invalid JSON body");
    }
    const parsed = cancelChildSessionRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return error("cancelNested must be a boolean");
    }
    body = parsed.data;
  }
  const cancelNested = body.cancelNested ?? true;

  const response = await ctx.sessionRuntime.fetch(childId, SessionInternalPaths.cancel, {
    method: "POST",
  });
  if (!response.ok && response.status !== 409) return response;
  if (!cancelNested) return response;

  const descendantIds = await sessionStore.listActiveDescendantIds(childId);
  const cancelledDescendantIds: string[] = [];
  const failedDescendantIds: string[] = [];
  for (const descendantId of descendantIds) {
    const descendantResponse = await ctx.sessionRuntime.fetch(
      descendantId,
      SessionInternalPaths.cancel,
      { method: "POST" }
    );
    if (descendantResponse.ok) {
      cancelledDescendantIds.push(descendantId);
    } else if (descendantResponse.status !== 409) {
      // 409 means the descendant reached a terminal state since the D1 query.
      failedDescendantIds.push(descendantId);
    }
  }
  if (failedDescendantIds.length > 0) {
    return json(
      {
        error: `Nested tasks could not be cancelled: ${failedDescendantIds.join(", ")}`,
        cancelledDescendantIds,
      },
      502
    );
  }

  // Cancelling descendants of an already-terminal child is still useful work;
  // report it as success rather than passing through the child's 409.
  if (response.ok || cancelledDescendantIds.length > 0) {
    return json({ status: "cancelled", cancelledDescendantIds });
  }

  return response;
}

export const sessionChildRoutes = new Hono<ControlPlaneHonoEnv>();

sessionChildRoutes.get(
  "/sessions/:id/children",
  admit({ ...GITHUB_SANDBOX_FALLBACK_ROUTE, authorization: requirePermission("sessions.read") }),
  (c) => dispatch(c, handleListChildren)
);
sessionChildRoutes.get(
  "/sessions/:id/children/:childId",
  admit({ ...GITHUB_SANDBOX_FALLBACK_ROUTE, authorization: requirePermission("sessions.read") }),
  (c) => dispatchSession(c, handleGetChild)
);
sessionChildRoutes.post(
  "/sessions/:id/children/:childId/cancel",
  admit({
    ...GITHUB_SANDBOX_FALLBACK_ROUTE,
    authorization: requirePermission("sessions.lifecycle"),
  }),
  (c) => dispatchSession(c, handleCancelChild)
);
sessionChildRoutes.post(
  "/sessions/:id/children/:childId/prompt",
  admit({ ...SCM_AGNOSTIC_SANDBOX_ROUTE, authorization: NO_AUTHORIZATION }),
  (c) => dispatchSession(c, handlePromptChild)
);
