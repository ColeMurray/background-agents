import type { Logger } from "../../../logger";
import type { EnqueuePromptRequest, MessageService } from "../../services/message.service";
import { parseEventListCursor } from "../../event-cursor";
import { z } from "zod";

const enqueuePromptRequestSchema = z.object({
  content: z.string(),
  authorId: z.string(),
  source: z.string(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  attachments: z
    .array(
      z.object({
        type: z.string(),
        name: z.string(),
        url: z.string().optional(),
      })
    )
    .optional(),
  callbackContext: z.record(z.string(), z.unknown()).optional(),
  authorDisplayName: z.string().optional(),
  authorEmail: z.string().optional(),
  authorLogin: z.string().optional(),
  scmUserId: z.string().optional(),
  scmAccessTokenEncrypted: z.string().optional(),
  scmRefreshTokenEncrypted: z.string().optional(),
  scmTokenExpiresAt: z.number().optional(),
}) satisfies z.ZodType<EnqueuePromptRequest>;

/**
 * Valid event types for filtering.
 * Includes both external types (from types.ts) and internal types used by the sandbox.
 */
const VALID_EVENT_TYPES = [
  "tool_call",
  "tool_result",
  "token",
  "error",
  "git_sync",
  "step_start",
  "step_finish",
  "execution_complete",
  "heartbeat",
  "push_complete",
  "push_error",
  "artifact",
  "user_message",
] as const;

/**
 * Valid message statuses for filtering.
 */
const VALID_MESSAGE_STATUSES = ["pending", "processing", "completed", "failed"] as const;

export interface MessagesHandlerDeps {
  messageService: MessageService;
  getLog: () => Logger;
}

export interface MessagesHandler {
  enqueuePrompt: (request: Request) => Promise<Response>;
  stop: () => Promise<Response>;
  listEvents: (url: URL) => Response;
  listArtifacts: (url: URL) => Response;
  listMessages: (url: URL) => Response;
}

export function createMessagesHandler(deps: MessagesHandlerDeps): MessagesHandler {
  return {
    async enqueuePrompt(request: Request): Promise<Response> {
      try {
        const raw = await request.json();
        const result = enqueuePromptRequestSchema.safeParse(raw);
        if (!result.success) {
          return Response.json({ error: "Invalid prompt request" }, { status: 400 });
        }

        return Response.json(await deps.messageService.enqueuePrompt(result.data));
      } catch (error) {
        deps.getLog().error("handleEnqueuePrompt error", {
          error: error instanceof Error ? error : String(error),
        });
        throw error;
      }
    },

    async stop(): Promise<Response> {
      return Response.json(await deps.messageService.stop());
    },

    listEvents(url: URL): Response {
      const cursorResult = parseEventListCursor(url.searchParams.get("cursor"));
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);
      const type = url.searchParams.get("type");
      const messageId = url.searchParams.get("message_id");

      if (type && !VALID_EVENT_TYPES.includes(type as (typeof VALID_EVENT_TYPES)[number])) {
        return Response.json({ error: `Invalid event type: ${type}` }, { status: 400 });
      }

      if (!cursorResult.ok) {
        return Response.json({ error: cursorResult.error }, { status: 400 });
      }

      const result = deps.messageService.listEvents({
        cursor: cursorResult.cursor,
        limit,
        type,
        messageId,
      });

      return Response.json(result);
    },

    listArtifacts(url: URL): Response {
      const artifactId = url.searchParams.get("artifactId");
      if (artifactId) {
        return Response.json(deps.messageService.getArtifact(artifactId));
      }

      return Response.json(deps.messageService.listArtifacts());
    },

    listMessages(url: URL): Response {
      const cursor = url.searchParams.get("cursor");
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 100);
      const status = url.searchParams.get("status");

      if (
        status &&
        !VALID_MESSAGE_STATUSES.includes(status as (typeof VALID_MESSAGE_STATUSES)[number])
      ) {
        return Response.json({ error: `Invalid message status: ${status}` }, { status: 400 });
      }

      const result = deps.messageService.listMessages({ cursor, limit, status });

      return Response.json({
        messages: result.messages.map((message) => ({
          id: message.id,
          authorId: message.author_id,
          content: message.content,
          source: message.source,
          status: message.status,
          createdAt: message.created_at,
          startedAt: message.started_at,
          completedAt: message.completed_at,
        })),
        cursor: result.cursor,
        hasMore: result.hasMore,
      });
    },
  };
}
