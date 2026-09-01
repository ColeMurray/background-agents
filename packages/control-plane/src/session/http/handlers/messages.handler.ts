import type { Logger } from "../../../logger";
import { eventTypeSchema } from "@open-inspect/shared/types/sandbox-events";
import {
  enqueuePromptRequestSchema,
  type EnqueuePromptRequest,
} from "../../enqueue-prompt-contract";
import type { MessageService } from "../../services/message.service";
import { parseEventListCursor } from "../../event-cursor";
import { parseEventChangeCursor } from "../../event-stream";
import {
  EventFeedCheckpointExpiredError,
  InvalidEventFeedCursorError,
} from "../../event-repository";
import { SessionAttachmentError } from "../../session-attachment-resolver";
import { parseCreatedAtIdCursor } from "../../list-cursor";
import {
  PromptQueueFullError,
  PromptRequestConflictError,
  SessionNotPromptableError,
} from "../../message-queue";

/**
 * Valid message statuses for filtering.
 */
const VALID_MESSAGE_STATUSES = ["pending", "processing", "completed", "failed"] as const;

/**
 * HTTP boundary for the prompt/event/artifact/message endpoints: parses
 * requests, delegates to the message service, and maps thrown domain errors
 * to statuses.
 */
export class MessagesHandler {
  constructor(private readonly messageService: MessageService) {}

  async enqueuePrompt(request: Request, log: Logger): Promise<Response> {
    try {
      const raw = await request.json();
      const result = enqueuePromptRequestSchema.safeParse(raw);
      if (!result.success) {
        return Response.json({ error: "Invalid prompt body" }, { status: 400 });
      }

      const body: EnqueuePromptRequest = result.data;
      return Response.json(await this.messageService.enqueuePrompt(body));
    } catch (error) {
      if (error instanceof SessionAttachmentError) {
        return Response.json({ error: error.message }, { status: 400 });
      }
      if (error instanceof SessionNotPromptableError) {
        return Response.json({ error: error.message }, { status: 409 });
      }
      if (error instanceof PromptQueueFullError) {
        return Response.json({ error: error.message, code: "PROMPT_QUEUE_FULL" }, { status: 429 });
      }
      if (error instanceof PromptRequestConflictError) {
        return Response.json(
          { error: error.message, code: "PROMPT_REQUEST_CONFLICT" },
          { status: 409 }
        );
      }
      log.error("handleEnqueuePrompt error", {
        error: error instanceof Error ? error : String(error),
      });
      throw error;
    }
  }

  async stop(): Promise<Response> {
    return Response.json(await this.messageService.stop());
  }

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

    const result = this.messageService.listEvents({
      cursor: cursorResult.cursor,
      limit,
      type,
      messageId,
    });

    return Response.json(result);
  }

  listEventChanges(url: URL): Response {
    const cursorValue = url.searchParams.get("cursor");
    const afterValue = url.searchParams.get("after");
    if (cursorValue && afterValue !== null) {
      return Response.json({ error: "after and cursor are mutually exclusive" }, { status: 400 });
    }
    const cursor = cursorValue ? parseEventChangeCursor(cursorValue) : null;
    const after = afterValue === null ? undefined : Number(afterValue);
    const limitValue = url.searchParams.get("limit");
    const limit = limitValue === null ? 100 : Number(limitValue);
    if (
      (cursorValue && !cursor) ||
      (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    ) {
      return Response.json({ error: "Invalid event change query" }, { status: 400 });
    }
    try {
      return Response.json(
        this.messageService.listEventChanges({ after, cursor: cursor ?? undefined, limit })
      );
    } catch (error) {
      if (error instanceof EventFeedCheckpointExpiredError) {
        return Response.json({ error: error.message }, { status: 410 });
      }
      if (error instanceof InvalidEventFeedCursorError) {
        return Response.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }
  }

  listArtifacts(url: URL): Response {
    const artifactId = url.searchParams.get("artifactId");
    if (artifactId) {
      return Response.json(this.messageService.getArtifact(artifactId));
    }

    const rawLimit = url.searchParams.get("limit");
    if (rawLimit === null) return Response.json(this.messageService.listArtifacts());
    const limit = Number(rawLimit);
    const rawCursor = url.searchParams.get("cursor");
    const cursor = parseCreatedAtIdCursor(rawCursor);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (rawCursor && !cursor)) {
      return Response.json({ error: "Invalid artifact pagination" }, { status: 400 });
    }
    return Response.json(this.messageService.listArtifacts({ cursor, limit }));
  }

  listMessages(url: URL): Response {
    const rawCursor = url.searchParams.get("cursor");
    const cursor = parseCreatedAtIdCursor(rawCursor);
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 100);
    const status = url.searchParams.get("status");

    if (
      (status &&
        !VALID_MESSAGE_STATUSES.includes(status as (typeof VALID_MESSAGE_STATUSES)[number])) ||
      (rawCursor !== null && !cursor)
    ) {
      return Response.json(
        {
          error:
            rawCursor !== null && !cursor ? "Invalid cursor" : `Invalid message status: ${status}`,
        },
        { status: 400 }
      );
    }

    const result = this.messageService.listMessages({ cursor, limit, status });

    return Response.json(result);
  }
}
