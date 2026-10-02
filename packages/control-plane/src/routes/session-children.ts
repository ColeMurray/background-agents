import { parseBody } from "./body";
import { Hono } from "hono";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  cancelChildSessionRequestSchema,
  childFollowUpPromptRequestSchema,
  sendPromptResponseSchema,
  type CancelChildSessionRequest,
} from "@open-inspect/shared/types/session-api";
import { DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS } from "@open-inspect/shared/types/integrations";
import { childSessionListResponseSchema } from "@open-inspect/shared/types/sessions";
import {
  SessionIndexStore,
  type ChildAdmissionLease,
  type SessionEntry,
} from "../db/session-index";
import { SessionCollaboratorStore } from "../db/session-collaborators";
import { TeamMembershipStore } from "../db/team-memberships";
import { AuthorizationError, AuthorizationService } from "../authorization/service";
import { checkSessionAccess, type SessionAction, type SessionViewer } from "@open-inspect/shared";
import {
  evaluateSessionAdmission,
  teamsEnforcementMode,
  viewerFromContext,
} from "../authorization/session-admission";
import { createLogger } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import { resolveSandboxSettings } from "../session/integration-settings-resolution";
import { activePromptAuthorSchema, type ActivePromptAuthor } from "../session/active-prompt-author";
import type { Env } from "../types";
import {
  error,
  GITHUB_SANDBOX_FALLBACK_ROUTE,
  json,
  NO_AUTHORIZATION,
  requireAll,
  requireSession,
  sessionRequirement,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
} from "./shared";
import { type SessionRouteContext, dispatchSession } from "./session-route";

const logger = createLogger("router:session-children");

function sandboxChildAccess(
  ctx: SessionRouteContext,
  parent: SessionEntry,
  activeAuthor?: ActivePromptAuthor
) {
  let viewerPromise: Promise<SessionViewer | null> | undefined;
  return async (child: SessionEntry, action: SessionAction): Promise<boolean> => {
    if (ctx.principal?.kind !== "sandbox" || ctx.principal.sessionId !== parent.id) return false;
    if (child.ownerTeamId !== parent.ownerTeamId) return false;
    // Non-read actions on team-owned children need the active prompt author's current membership.
    if (
      (action === "read" || child.ownerTeamId === null) &&
      (child.visibility === "workspace" ||
        (child.visibility === "team" && parent.visibility === "team"))
    )
      return true;

    viewerPromise ??= (async () => {
      let author = activeAuthor;
      if (!author) {
        const response = await ctx.sessionRuntime.fetch(
          parent.id,
          SessionInternalPaths.activePromptAuthor
        );
        if (!response.ok) return null;
        const parsed = activePromptAuthorSchema.safeParse(await response.json());
        if (!parsed.success) return null;
        author = parsed.data;
      }
      const userId = author.canonicalUserId;
      if (!userId) return null;
      let authorization;
      try {
        authorization = await new AuthorizationService(ctx.db).getEffectiveAuthorization(userId);
      } catch (cause) {
        if (cause instanceof AuthorizationError) return null;
        throw cause;
      }
      return {
        kind: "user" as const,
        userId,
        roleKey: authorization.role.key,
        permissions: authorization.permissions,
        suspended: authorization.suspendedAt !== null,
        memberships: await new TeamMembershipStore(ctx.db).listForUser(userId),
      };
    })();
    const viewer = await viewerPromise;
    if (!viewer || viewer.kind !== "user") return false;
    const collaboratorIds = await new SessionCollaboratorStore(ctx.db).listUserIds(child.id);
    if (
      child.visibility === "private" &&
      child.userId !== viewer.userId &&
      !collaboratorIds.includes(viewer.userId)
    )
      return false;
    return checkSessionAccess(
      viewer,
      {
        id: child.id,
        ownerUserId: child.userId ?? null,
        ownerTeamId: child.ownerTeamId,
        visibility: child.visibility,
        collaboratorIds,
      },
      action
    ).allowed;
  };
}

export async function handleListChildren(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const parentId = params.id;

  const sessionStore = new SessionIndexStore(ctx.db);
  const readScope =
    ctx.principal?.kind === "sandbox"
      ? { kind: "internal" as const, reason: "parent-bound sandbox" }
      : (ctx.sessionAdmission?.viewer ??
        viewerFromContext(ctx, ctx.sessionMemberships ?? new Map()));
  const children = await sessionStore.listByParent(
    parentId,
    readScope,
    teamsEnforcementMode(ctx, env)
  );

  if (ctx.principal?.kind === "sandbox" && children.length) {
    const parent = await sessionStore.get(parentId);
    if (!parent) return error("Session not found", 404);
    const canAccess = sandboxChildAccess(ctx, parent);
    const visible: SessionEntry[] = [];
    for (const child of children) {
      if (await canAccess(child, "read")) visible.push(child);
    }
    return json(childSessionListResponseSchema.parse({ children: visible }));
  }

  return json(childSessionListResponseSchema.parse({ children }));
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
  if (ctx.principal?.kind === "sandbox") {
    const [parent, child] = await Promise.all([
      sessionStore.get(parentId),
      sessionStore.get(childId),
    ]);
    if (!parent || !child || !(await sandboxChildAccess(ctx, parent)(child, "read"))) {
      return error("Child session not found", 404);
    }
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

  const parsed = await parseBody(request, childFollowUpPromptRequestSchema, "Invalid prompt body");
  if (parsed instanceof Response) return parsed;

  const sessionStore = new SessionIndexStore(ctx.db);
  const childSession = await sessionStore.get(childId);
  if (!childSession || childSession.parentSessionId !== parentId) {
    return error("Child session not found", 404);
  }
  const parentSession = await sessionStore.get(parentId);
  if (!parentSession) return error("Parent session not found", 404);
  if (childSession.ownerTeamId !== parentSession.ownerTeamId) {
    return json({ error: "Child has moved", code: "child_moved" }, 409);
  }

  const authorResponse = await ctx.sessionRuntime.fetch(
    parentId,
    SessionInternalPaths.activePromptAuthor
  );
  if (!authorResponse.ok) return authorResponse;
  const author = activePromptAuthorSchema.safeParse(await authorResponse.json());
  if (!author.success) return error("Failed to get active prompt author", 500);
  if (!(await sandboxChildAccess(ctx, parentSession, author.data)(childSession, "collaborate")))
    return error("Child session not found", 404);

  let admissionLease: ChildAdmissionLease | null = null;
  if (childSession.status === "completed" || childSession.status === "failed") {
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
      content: parsed.content,
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
  let canAccess: ReturnType<typeof sandboxChildAccess> | null = null;
  if (ctx.principal?.kind === "sandbox") {
    const [parent, child] = await Promise.all([
      sessionStore.get(parentId),
      sessionStore.get(childId),
    ]);
    if (!parent || !child) return error("Child session not found", 404);
    canAccess = sandboxChildAccess(ctx, parent);
    if (!(await canAccess(child, "lifecycle"))) return error("Child session not found", 404);
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

  const descendantIds = cancelNested ? await sessionStore.listActiveDescendantIds(childId) : [];
  for (const descendantId of descendantIds) {
    if (canAccess) {
      const descendant = await sessionStore.get(descendantId);
      if (!descendant || !(await canAccess(descendant, "lifecycle"))) {
        return error("Child session not found", 404);
      }
    } else {
      const result = await evaluateSessionAdmission(ctx, env, descendantId, "lifecycle", null);
      if (result.kind === "not_found") return error("Child session not found", 404);
      if (result.kind === "action_denied") {
        return json(
          { error: "Forbidden", code: "session_action_denied", reason_code: result.reason },
          403
        );
      }
    }
  }

  const response = await ctx.sessionRuntime.fetch(childId, SessionInternalPaths.cancel, {
    method: "POST",
  });
  if (!response.ok && response.status !== 409) return response;
  if (!cancelNested) return response;

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
  admit({ ...GITHUB_SANDBOX_FALLBACK_ROUTE, authorization: requireSession("read") }),
  (c) => dispatchSession(c, handleListChildren)
);
sessionChildRoutes.get(
  "/sessions/:id/children/:childId",
  admit({
    ...GITHUB_SANDBOX_FALLBACK_ROUTE,
    authorization: requireAll(sessionRequirement("read"), sessionRequirement("read", "childId")),
  }),
  (c) => dispatchSession(c, handleGetChild)
);
sessionChildRoutes.post(
  "/sessions/:id/children/:childId/cancel",
  admit({
    ...GITHUB_SANDBOX_FALLBACK_ROUTE,
    authorization: requireAll(
      sessionRequirement("read"),
      sessionRequirement("lifecycle", "childId")
    ),
  }),
  (c) => dispatchSession(c, handleCancelChild)
);
sessionChildRoutes.post(
  "/sessions/:id/children/:childId/prompt",
  admit({ ...SCM_AGNOSTIC_SANDBOX_ROUTE, authorization: NO_AUTHORIZATION }),
  (c) => dispatchSession(c, handlePromptChild)
);
