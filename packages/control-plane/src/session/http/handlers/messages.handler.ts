import type { Logger } from "../../../logger";
import { eventTypeSchema } from "@open-inspect/shared/types/sandbox-events";
import {
  enqueuePromptRequestSchema,
  type EnqueuePromptRequest,
} from "../../enqueue-prompt-contract";
import type { MessageService } from "../../services/message.service";
import { parseEventListCursor } from "../../event-cursor";
import { SessionAttachmentError } from "../../session-attachment-resolver";
import { SessionNotPromptableError } from "../../message-queue";

/**
 * Valid message statuses for filtering.
 */
const VALID_MESSAGE_STATUSES = ["pending", "processing", "completed", "failed"] as const;

export interface MessagesHandlerDeps {
  messageService: MessageService;
}

export interface MessagesHandler {
  enqueuePrompt: (request: Request, log: Logger) => Promise<Response>;
  stop: () => Promise<Response>;
  listEvents: (url: URL) => Response;
  listArtifacts: (url: URL) => Response;
  listMessages: (url: URL) => Response;
}

export function createMessagesHandler(deps: MessagesHandlerDeps): MessagesHandler {
  return {
    async enqueuePrompt(request: Request, log: Logger): Promise<Response> {
      try {
        const raw = await request.json();
        const result = enqueuePromptRequestSchema.safeParse(raw);
        if (!result.success) {
          return Response.json({ error: "Invalid prompt body" }, { status: 400 });
        }

        const body: EnqueuePromptRequest = result.data;
        return Response.json(await deps.messageService.enqueuePrompt(body));
      } catch (error) {
        if (error instanceof SessionAttachmentError) {
          return Response.json({ error: error.message }, { status: 400 });
        }
        if (error instanceof SessionNotPromptableError) {
          return Response.json({ error: error.message }, { status: 409 });
        }
        log.error("handleEnqueuePrompt error", {
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

      if (type && !eventTypeSchema.safeParse(type).success) {
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

      return Response.json(result);
    },
  };
}
