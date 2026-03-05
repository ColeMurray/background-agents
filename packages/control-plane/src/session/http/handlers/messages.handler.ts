import type { Logger } from "../../../logger";
import type { EnqueuePromptRequest, MessageService } from "../../services/message.service";

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
  listArtifacts: () => Response;
  listMessages: (url: URL) => Response;
}

export function createMessagesHandler(deps: MessagesHandlerDeps): MessagesHandler {
  return {
    async enqueuePrompt(request: Request): Promise<Response> {
      try {
        const body = (await request.json()) as EnqueuePromptRequest;
        return Response.json(await deps.messageService.enqueuePrompt(body));
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
      const cursor = url.searchParams.get("cursor");
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);
      const type = url.searchParams.get("type");
      const messageId = url.searchParams.get("message_id");

      if (type && !VALID_EVENT_TYPES.includes(type as (typeof VALID_EVENT_TYPES)[number])) {
        return Response.json({ error: `Invalid event type: ${type}` }, { status: 400 });
      }

      const result = deps.messageService.listEvents({ cursor, limit, type, messageId });

      return Response.json({
        events: result.events.map((event) => ({
          id: event.id,
          type: event.type,
          data: JSON.parse(event.data),
          messageId: event.message_id,
          createdAt: event.created_at,
        })),
        cursor: result.cursor,
        hasMore: result.hasMore,
      });
    },

    listArtifacts(): Response {
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
