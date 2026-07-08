import { attachmentSchema, type Attachment, type CallbackContext } from "@open-inspect/shared";
import { PROMPT_UPLOAD_IMAGE_MAX_BYTES, PROMPT_UPLOAD_VIDEO_MAX_BYTES } from "../media";
import { SessionIndexStore } from "../db/session-index";
import { UserStore } from "../db/user-store";
import { createLogger } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import { parseAuthorId, resolveGitHubEnrichment, type GitHubEnrichment } from "../session/identity";
import type { Env } from "../types";
import { error, parsePattern, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

const logger = createLogger("router:session-prompt");
const MAX_ATTACHMENTS_PER_PROMPT = 6;

function base64ByteLength(content: string): number | null {
  const normalized = content.replace(/\s/g, "");
  if (normalized.length === 0) return 0;
  if (normalized.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;

  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return (normalized.length / 4) * 3 - padding;
}

function validateAttachments(raw: unknown): Attachment[] | Response | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return error("attachments must be an array", 400);
  if (raw.length > MAX_ATTACHMENTS_PER_PROMPT) {
    return error(`You can attach up to ${MAX_ATTACHMENTS_PER_PROMPT} files per message`, 400);
  }

  const attachments: Attachment[] = [];
  for (const item of raw) {
    const result = attachmentSchema.safeParse(item);
    if (!result.success) return error("Invalid attachment", 400);

    const attachment = result.data;
    if (attachment.content) {
      const byteLength = base64ByteLength(attachment.content);
      if (byteLength === null) return error("Invalid attachment content", 400);

      const maxBytes = attachment.mimeType?.startsWith("video/")
        ? PROMPT_UPLOAD_VIDEO_MAX_BYTES
        : PROMPT_UPLOAD_IMAGE_MAX_BYTES;
      if (byteLength > maxBytes) {
        return error(`${attachment.name} exceeds the attachment size limit`, 413);
      }
    }
    attachments.push(attachment);
  }
  return attachments;
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

  let enrichment: GitHubEnrichment | undefined;
  const parsed = parseAuthorId(authorId);
  if (parsed) {
    try {
      const userStore = new UserStore(env.DB);
      const identity = await userStore.getIdentity(parsed.provider, parsed.providerUserId);
      if (identity) {
        enrichment = (await resolveGitHubEnrichment(env, userStore, identity.userId)) ?? undefined;
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
      callbackContext: body.callbackContext,
      authorDisplayName: enrichment?.displayName,
      authorEmail: enrichment?.email,
      authorLogin: enrichment?.scmLogin,
      scmUserId: enrichment?.scmUserId,
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
