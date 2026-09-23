/**
 * Control-plane callbacks. `/tool_call` refreshes the live status message in
 * the task thread; `/complete` marks it finished and posts the result.
 */

import { Hono } from "hono";
import { z } from "zod";
import { isSignedCallbackPayload, verifyCallbackFromControlPlane } from "@open-inspect/shared/auth";
import { extractAgentResponse } from "@open-inspect/shared/completion/extractor";
import { resolveOutboundCredential } from "@open-inspect/shared/service-auth";
import { discordCallbackContextSchema } from "@open-inspect/shared/types/session-api";
import type { AgentResponse } from "@open-inspect/shared/types/artifacts";
import { postChannelMessage } from "./discord-api";
import { formatCompletion } from "./format";
import { createLogger } from "./logger";
import { finishProgress, recordStep } from "./progress";
import { sessionUrl } from "./task";
import type { Env } from "./types";

const log = createLogger("callback");

const completionCallbackSchema = z.object({
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
  success: z.boolean(),
  error: z.string().optional(),
  timestamp: z.number(),
  context: discordCallbackContextSchema,
  signature: z.string().min(1),
});

const toolCallCallbackSchema = z.object({
  sessionId: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  callId: z.string().min(1),
  status: z.string().optional(),
  timestamp: z.number(),
  context: discordCallbackContextSchema,
  signature: z.string().min(1),
});

/** Where replies for a callback context go: the task thread, else its channel. */
function replyChannel(context: z.infer<typeof discordCallbackContextSchema>): string {
  return context.threadId ?? context.channelId;
}

async function isAuthentic(env: Env, payload: unknown): Promise<boolean> {
  return isSignedCallbackPayload(payload) && (await verifyCallbackFromControlPlane(payload, env));
}

export const callbacksRouter = new Hono<{ Bindings: Env }>();

callbacksRouter.post("/complete", async (c) => {
  const payload: unknown = await c.req.json().catch(() => null);
  if (!(await isAuthentic(c.env, payload))) return c.json({ error: "unauthorized" }, 401);

  const parsed = completionCallbackSchema.safeParse(payload);
  if (!parsed.success) return c.json({ error: "invalid payload" }, 400);

  c.executionCtx.waitUntil(postCompletion(c.env, parsed.data));
  return c.json({ ok: true });
});

callbacksRouter.post("/tool_call", async (c) => {
  const payload: unknown = await c.req.json().catch(() => null);
  if (!(await isAuthentic(c.env, payload))) return c.json({ error: "unauthorized" }, 401);

  const parsed = toolCallCallbackSchema.safeParse(payload);
  if (!parsed.success) return c.json({ error: "invalid payload" }, 400);

  c.executionCtx.waitUntil(
    recordStep(c.env, {
      sessionId: parsed.data.sessionId,
      channelId: replyChannel(parsed.data.context),
      tool: parsed.data.tool,
      args: parsed.data.args,
    })
  );
  return c.json({ ok: true });
});

async function postCompletion(
  env: Env,
  callback: z.infer<typeof completionCallbackSchema>
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
      messageId
    );
  } catch (error) {
    // Still report the outcome; the session link has the details.
    log.warn("callback.extract_failed", { session_id: sessionId, error });
  }

  const channelId = replyChannel(context);
  await finishProgress(env, { sessionId, channelId, success: callback.success });

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
    log.info("callback.completed", { session_id: sessionId, success: callback.success });
  } catch (error) {
    log.error("callback.post_failed", { session_id: sessionId, error });
  }
}
