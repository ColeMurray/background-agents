import {
  MAX_SESSION_ATTACHMENTS_PER_MESSAGE,
  sessionAttachmentReferencesSchema,
  type CallbackContext,
  type SessionAttachmentReference,
} from "@open-inspect/shared";
import { SessionIndexStore } from "../db/session-index";
import { UserStore } from "../db/user-store";
import { createLogger } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import { parseAuthorId, resolveGitHubEnrichment, type GitHubEnrichment } from "../session/identity";
import type { Env } from "../types";
import { error, parsePattern, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

const logger = createLogger("router:session-prompt");

type GitHubEnrichmentResult =
  | { status: "resolved"; enrichment: GitHubEnrichment }
  | { status: "absent" }
  | { status: "unavailable" };

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
    authorId?: string;
    source?: string;
    model?: string;
    reasoningEffort?: string;
    attachments?: unknown;
    callbackContext?: CallbackContext;
  };

  if (!body.content) {
    return error("content is required");
  }

  const attachments = validateAttachments(body.attachments);
  if (attachments instanceof Response) return attachments;

  const authorId = body.authorId || "anonymous";

  let enrichmentResult: GitHubEnrichmentResult = { status: "absent" };
  const parsed = parseAuthorId(authorId);
  if (authorId !== "anonymous") {
    try {
      const userStore = new UserStore(env.DB);
      let userId: string | undefined;
      if (parsed) {
        const identity = await userStore.getIdentity(parsed.provider, parsed.providerUserId);
        userId = identity?.userId;
      } else {
        userId = (await userStore.getUserById(authorId))?.id;
      }
      if (userId) {
        const enrichment = await resolveGitHubEnrichment(env, userStore, userId);
        enrichmentResult = enrichment ? { status: "resolved", enrichment } : { status: "absent" };
      }
    } catch (e) {
      enrichmentResult = { status: "unavailable" };
      logger.warn("Failed to enrich prompt with GitHub identity", {
        error: e instanceof Error ? e : String(e),
        authorId,
      });
    }
  }

  const enrichment =
    enrichmentResult.status === "resolved" ? enrichmentResult.enrichment : undefined;

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
      callbackContext: body.callbackContext,
      scmIdentity:
        enrichmentResult.status === "resolved"
          ? {
              userId: enrichmentResult.enrichment.scmUserId,
              login: enrichmentResult.enrichment.scmLogin ?? null,
              name: enrichmentResult.enrichment.displayName ?? null,
              email: enrichmentResult.enrichment.email ?? null,
            }
          : enrichmentResult.status === "absent"
            ? null
            : undefined,
      scmAccessTokenEncrypted: enrichment?.accessTokenEncrypted,
      scmRefreshTokenEncrypted: enrichment?.refreshTokenEncrypted,
      scmTokenExpiresAt: enrichment?.tokenExpiresAt,
    }),
  });

  const store = new SessionIndexStore(env.DB);
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
