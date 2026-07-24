import {
  MAX_SESSION_ATTACHMENTS_PER_MESSAGE,
  sessionAttachmentReferencesSchema,
  type CallbackContext,
  type SessionAttachmentReference,
} from "@open-inspect/shared";
import { applyIdentityEnforcement, mayAttachCallbackContext } from "../auth/identity-enforcement";
import { SessionIndexStore } from "../db/session-index";
import { UserStore } from "../db/user-store";
import { createLogger } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import { parseAuthorId, resolveGitHubEnrichment, type GitHubEnrichment } from "../session/identity";
import type { Env } from "../types";
import { error, parsePattern, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

const logger = createLogger("router:session-prompt");

function validateAttachments(raw: unknown): SessionAttachmentReference[] | Response | undefined {
  if (raw === undefined) return undefined;
  const result = sessionAttachmentReferencesSchema.safeParse(raw);
  if (!result.success) {
    if (Array.isArray(raw) && raw.length > MAX_SESSION_ATTACHMENTS_PER_MESSAGE) {
      return error(
        `You can attach up to ${MAX_SESSION_ATTACHMENTS_PER_MESSAGE} files per message`,
        400
      );
    }
    return error("Invalid attachments", 400);
  }
  return result.data;
}

async function handleSessionPrompt(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const body = (await request.json()) as {
    content: string;
    source?: string;
    model?: string;
    reasoningEffort?: string;
    attachments?: unknown;
    callbackContext?: CallbackContext;
  };

  if (!body.content) {
    return error("content is required");
  }
  const enforcement = applyIdentityEnforcement(ctx, "prompt", body);
  if (enforcement.rejection) return enforcement.rejection;

  const attachments = validateAttachments(body.attachments);
  if (attachments instanceof Response) return attachments;

  // The author comes from the verified principal (user → canonical id, bot →
  // asserted actor); an actorless bot prompt is system-initiated and stays
  // anonymous. callbackContext is a completion notification channel — only
  // the bots that own callbacks may attach one.
  const authorId = enforcement.enforced.participantUserId ?? "anonymous";
  const callbackContext = mayAttachCallbackContext(ctx) ? body.callbackContext : undefined;
  if (callbackContext === undefined && body.callbackContext !== undefined) {
    logger.warn("Dropped callbackContext from unauthorized principal", {
      event: "identity.callback_context_dropped",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
  }

  let enrichment: GitHubEnrichment | undefined;
  const parsed = parseAuthorId(authorId);
  if (authorId !== "anonymous") {
    try {
      const userStore = new UserStore(ctx.db);
      let userId: string | undefined;
      if (parsed) {
        const identity = await userStore.getIdentity(parsed.provider, parsed.providerUserId);
        userId = identity?.userId;
      } else {
        userId = (await userStore.getUserById(authorId))?.id;
      }
      if (userId) {
        enrichment = (await resolveGitHubEnrichment(env, ctx.db, userStore, userId)) ?? undefined;
      }
    } catch (e) {
      logger.warn("Failed to enrich prompt with GitHub identity", {
        error: e instanceof Error ? e : String(e),
        authorId,
      });
    }
  }

  const response = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.prompt, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: body.content,
      authorId,
      source: body.source || "web",
      model: body.model,
      reasoningEffort: body.reasoningEffort,
      attachments,
      callbackContext,
      scmEnrichment: enrichment
        ? {
            userId: enrichment.scmUserId,
            login: enrichment.scmLogin ?? null,
            name: enrichment.displayName ?? null,
            email: enrichment.email ?? null,
            accessTokenEncrypted: enrichment.accessTokenEncrypted ?? null,
            refreshTokenEncrypted: enrichment.refreshTokenEncrypted ?? null,
            tokenExpiresAt: enrichment.tokenExpiresAt ?? null,
          }
        : undefined,
    }),
  });

  const store = new SessionIndexStore(ctx.db);
  ctx.executionCtx?.waitUntil(
    store.touchUpdatedAt(sessionId).catch((error) => {
      logger.error("session_index.touch_updated_at.background_error", {
        session_id: sessionId,
        trace_id: ctx.trace_id,
        request_id: ctx.request_id,
        error,
      });
    })
  );

  return response;
}

export const sessionPromptRoutes: Route[] = [
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/prompt"),
    handler: handleSessionPrompt,
  }),
];
