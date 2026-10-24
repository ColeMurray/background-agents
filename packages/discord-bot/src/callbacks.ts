/** Signed control-plane callbacks for progress, completion, and publication revocation. */

import { Hono, type Context } from "hono";
import type { z } from "zod";
import { getCallbackAuthRejection } from "@open-inspect/shared/callback-auth";
import { extractAgentResponse } from "@open-inspect/shared/completion/extractor";
import { resolveOutboundCredential } from "@open-inspect/shared/service-auth";
import {
  discordCompletionCallbackSchema,
  discordToolCallCallbackSchema,
  discordPublicationStoppedCallbackSchema,
  DISCORD_PUBLICATION_STOPPED_MAX_AGE_MS,
  type DiscordCallbackContext,
  type DiscordCompletionCallback,
} from "@open-inspect/shared/types/session-api";
import type { AgentResponse } from "@open-inspect/shared/types/artifacts";
import { postChannelMessage } from "./discord-api";
import { formatCompletion } from "./format";
import { sessionUrl } from "./links";
import { createLogger } from "./logger";
import { finishProgress, recordStep, stopPublication } from "./progress";
import type { Env } from "./types";

const log = createLogger("callback");
type CallbackEnv = { Bindings: Env; Variables: { traceId: string } };

/** Where replies go: the task thread, else its channel. */
function replyChannel(context: Pick<DiscordCallbackContext, "channelId" | "threadId">): string {
  return context.threadId ?? context.channelId;
}

/** Authenticate the original object, before schemas trim strings or strip properties. */
async function parseCallback<T>(
  c: Context<CallbackEnv>,
  schema: z.ZodType<T>
): Promise<{ data: T; rejection?: never } | { data?: never; rejection: Response }> {
  let payload: unknown;
  let malformed = false;
  try {
    payload = await c.req.json();
  } catch {
    malformed = true;
  }
  const rejection = await getCallbackAuthRejection(payload, c.env);
  // Preserve configuration-first responses, then surface syntactically malformed JSON as 400.
  if (rejection?.status === 500) {
    return { rejection: c.json({ error: rejection.error }, rejection.status) };
  }
  if (malformed) return { rejection: c.json({ error: "invalid payload" }, 400) };
  if (rejection) return { rejection: c.json({ error: rejection.error }, rejection.status) };
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return { rejection: c.json({ error: "invalid payload" }, 400) };
  return { data: parsed.data };
}

export const callbacksRouter = new Hono<CallbackEnv>();

callbacksRouter.use("*", async (c, next) => {
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
  const startedAt = Date.now();
  c.set("traceId", traceId);
  await next();
  const fields = {
    trace_id: traceId,
    http_path: c.req.path,
    http_status: c.res.status,
    duration_ms: Date.now() - startedAt,
    outcome: c.res.status >= 500 ? "error" : c.res.status >= 400 ? "rejected" : "success",
  };
  if (c.res.status >= 500) log.error("http.request", fields);
  else if (c.res.status >= 400) log.warn("http.request", fields);
  else log.info("http.request", fields);
});

callbacksRouter.post("/complete", async (c) => {
  const parsed = await parseCallback(c, discordCompletionCallbackSchema);
  if (parsed.rejection) return parsed.rejection;
  c.executionCtx.waitUntil(postCompletion(c.env, parsed.data, c.get("traceId")));
  return c.json({ ok: true });
});

callbacksRouter.post("/tool_call", async (c) => {
  const parsed = await parseCallback(c, discordToolCallCallbackSchema);
  if (parsed.rejection) return parsed.rejection;
  const { context, tool, args } = parsed.data;
  // No status message means posting it failed; there is nothing to update.
  if (context.statusMessage) {
    c.executionCtx.waitUntil(
      recordStep(c.env, {
        channelId: replyChannel(context),
        statusMessage: context.statusMessage,
        tool,
        args,
      })
    );
  }
  return c.json({ ok: true });
});

callbacksRouter.post("/publication_stopped", async (c) => {
  const parsed = await parseCallback(c, discordPublicationStoppedCallbackSchema);
  if (parsed.rejection) return parsed.rejection;
  const { timestamp, context, sessionId } = parsed.data;
  if (Math.abs(Date.now() - timestamp) > DISCORD_PUBLICATION_STOPPED_MAX_AGE_MS) {
    return c.json({ error: "invalid payload" }, 400);
  }
  // No content reads, new messages, or cancellation claims are permitted on this route.
  if (context.statusMessage) {
    try {
      await stopPublication(c.env, {
        channelId: replyChannel(context),
        statusMessage: context.statusMessage,
      });
    } catch (error) {
      log.error("callback.publication_stop_failed", {
        trace_id: c.get("traceId"),
        session_id: sessionId,
        error,
      });
      return c.json({ error: "could not stop updates" }, 503);
    }
  }
  return c.json({ ok: true });
});

async function postCompletion(
  env: Env,
  callback: DiscordCompletionCallback,
  traceId: string
): Promise<void> {
  const { sessionId, messageId, context } = callback;
  let response: AgentResponse | null = null;
  try {
    response = await extractAgentResponse(
      {
        fetcher: env.CONTROL_PLANE,
        auth: resolveOutboundCredential("discord-bot", env),
        log,
      },
      sessionId,
      messageId,
      traceId
    );
  } catch (error) {
    // Still report the outcome; the session link has the details.
    log.warn("callback.extract_failed", { trace_id: traceId, session_id: sessionId, error });
  }

  const channelId = replyChannel(context);
  if (context.statusMessage) {
    await finishProgress(env, {
      channelId,
      statusMessage: context.statusMessage,
      success: callback.success,
    });
  }

  try {
    await postChannelMessage(env.DISCORD_BOT_TOKEN, channelId, {
      content: formatCompletion({
        userId: context.userId,
        success: callback.success,
        error: callback.error,
        response,
        sessionUrl: sessionUrl(env, sessionId),
      }),
      mentionUserIds: [context.userId],
    });
    log.info("callback.completed", {
      trace_id: traceId,
      session_id: sessionId,
      success: callback.success,
    });
  } catch (error) {
    log.error("callback.post_failed", { trace_id: traceId, session_id: sessionId, error });
  }
}
