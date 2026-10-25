import {
  discordCompletionCallbackPayloadSchema,
  discordPublicationStoppedCallbackPayloadSchema,
  discordToolCallCallbackPayloadSchema,
  DISCORD_PUBLICATION_STOPPED_KIND,
  linearCompletionCallbackPayloadSchema,
  linearToolCallCallbackPayloadSchema,
} from "@open-inspect/shared/types/session-api";
import { messageSourceSchema, type MessageSource } from "@open-inspect/shared/types/sessions";
import type { z } from "zod";
import type { CallbackDestination } from "../auth/service/callback-signing";
import type { CallbackPublicationScope } from "../authorization/callback-publication-scope";
import { slackPostGate } from "../authorization/slack-post-gate";
import { teamlessPublicationGate } from "../authorization/teamless-publication-gate";

export interface CallbackNotification {
  path: string;
  payload: Record<string, unknown>;
}

/** Routing and publication policy only; signing and delivery remain centralized. */
export interface CallbackRoute {
  destination: CallbackDestination;
  binding: "SLACK_BOT" | "LINEAR_BOT" | "DISCORD_BOT";
  completionSchema?: z.ZodType<Record<string, unknown>>;
  toolCallSchema?: z.ZodType<Record<string, unknown>>;
  /** Explicit legacy contract, independent of whether a route validates payloads. */
  defaultArgs?: Record<string, unknown>;
  postGate(
    scope: CallbackPublicationScope,
    sessionId: string,
    context: unknown
  ): Promise<string | null>;
  denial?: {
    notification(
      sessionId: string,
      context: unknown,
      timestamp: number
    ): CallbackNotification | null;
    failureEvent: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SLACK_CALLBACK_ROUTE: CallbackRoute = {
  destination: "slack-bot",
  binding: "SLACK_BOT",
  defaultArgs: {},
  async postGate(scope, sessionId, context) {
    if (!isRecord(context) || typeof context.channel !== "string" || !context.channel) {
      return "invalid_callback_context";
    }
    const [session, binding] = await Promise.all([
      scope.getSession(sessionId),
      scope.getChannelBinding(context.channel),
    ]);
    return slackPostGate(session, binding);
  },
  denial: {
    failureEvent: "callback.thread_closed_delivery_attempt_failed",
    notification(sessionId, context, timestamp) {
      if (
        !isRecord(context) ||
        typeof context.channel !== "string" ||
        !context.channel ||
        typeof context.threadTs !== "string" ||
        !context.threadTs
      ) {
        return null;
      }
      return {
        path: "/callbacks/thread_closed",
        payload: {
          kind: "slack.thread_closed",
          sessionId,
          timestamp,
          context: { channel: context.channel, threadTs: context.threadTs },
        },
      };
    },
  },
};

const CALLBACK_ROUTES: Partial<Record<MessageSource, CallbackRoute>> = {
  slack: SLACK_CALLBACK_ROUTE,
  linear: {
    destination: "linear-bot",
    binding: "LINEAR_BOT",
    completionSchema: linearCompletionCallbackPayloadSchema,
    toolCallSchema: linearToolCallCallbackPayloadSchema,
    // Linear owns its destinations and does not use shared-chat publication scope.
    postGate: async () => null,
  },
  discord: {
    destination: "discord-bot",
    binding: "DISCORD_BOT",
    completionSchema: discordCompletionCallbackPayloadSchema,
    toolCallSchema: discordToolCallCallbackPayloadSchema,
    postGate: async (scope, sessionId) =>
      teamlessPublicationGate(await scope.getSession(sessionId)),
    denial: {
      failureEvent: "callback.publication_stopped_delivery_attempt_failed",
      notification(sessionId, context, timestamp) {
        if (!isRecord(context)) return null;
        // Pick coordinates, never spread the content-bearing callback context.
        const statusMessage = isRecord(context.statusMessage)
          ? { id: context.statusMessage.id, startedAt: context.statusMessage.startedAt }
          : context.statusMessage;
        const parsed = discordPublicationStoppedCallbackPayloadSchema.safeParse({
          kind: DISCORD_PUBLICATION_STOPPED_KIND,
          sessionId,
          timestamp,
          context: {
            channelId: context.channelId,
            ...(context.threadId !== undefined ? { threadId: context.threadId } : {}),
            ...(statusMessage !== undefined ? { statusMessage } : {}),
          },
        });
        return parsed.success
          ? { path: "/callbacks/publication_stopped", payload: parsed.data }
          : null;
      },
    },
  },
};

/** Legacy sources use Slack, including unknown persisted strings and null. */
export function resolveCallbackRoute(source: string | null): CallbackRoute {
  const parsed = messageSourceSchema.safeParse(source);
  return (parsed.success && CALLBACK_ROUTES[parsed.data]) || SLACK_CALLBACK_ROUTE;
}
