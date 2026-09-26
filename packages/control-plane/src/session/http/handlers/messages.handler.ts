import type { Logger } from "../../../logger";
import { eventTypeSchema } from "@open-inspect/shared/types/sandbox-events";
import { messageStatusSchema } from "@open-inspect/shared/types/sessions";
import { promptValidationError } from "@open-inspect/shared/types/prompts";
import {
  enqueuePromptRequestSchema,
  type EnqueuePromptRequest,
} from "../../enqueue-prompt-contract";
import type { MessageService } from "../../services/message.service";
import { parseEventListCursor } from "../../event-cursor";
import { parseMessageListCursor } from "../../message-cursor";
import { SessionAttachmentError } from "../../session-attachment-resolver";
import { sessionTraceFormatSchema, sessionTraceIncludeSchema } from "../../contracts";
import {
  BudgetExhaustedError,
  PromptQueueFullError,
  HarnessModelIncompatibleError,
  PromptRequestConflictError,
  SessionNotPromptableError,
} from "../../message-queue";

/**
 * HTTP boundary for the prompt/event/artifact/message/trace endpoints: parses
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
        return Response.json(promptValidationError(result.error, raw), { status: 400 });
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
      if (error instanceof BudgetExhaustedError) {
        return Response.json({ error: error.message, code: "BUDGET_EXHAUSTED" }, { status: 409 });
      }
      if (error instanceof PromptQueueFullError) {
        return Response.json({ error: error.message, code: "PROMPT_QUEUE_FULL" }, { status: 429 });
      }
      if (error instanceof HarnessModelIncompatibleError) {
        return Response.json(
          { error: error.message, code: "HARNESS_MODEL_INCOMPATIBLE" },
          { status: 400 }
        );
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

  listArtifacts(url: URL): Response {
    const artifactId = url.searchParams.get("artifactId");
    if (artifactId) {
      return Response.json(this.messageService.getArtifact(artifactId));
    }

    return Response.json(this.messageService.listArtifacts());
  }

  listMessages(url: URL): Response {
    const cursorResult = parseMessageListCursor(url.searchParams.get("cursor"));
    const limit = parsePageLimit(url.searchParams.get("limit"), 50, 100);
    if (limit === null) {
      return Response.json({ error: "Invalid limit" }, { status: 400 });
    }
    const status = url.searchParams.get("status");

    if (status && !messageStatusSchema.safeParse(status).success) {
      return Response.json({ error: `Invalid message status: ${status}` }, { status: 400 });
    }

    if (!cursorResult.ok) {
      return Response.json({ error: cursorResult.error }, { status: 400 });
    }

    const result = this.messageService.listMessages({ cursor: cursorResult.cursor, limit, status });

    return Response.json(result);
  }

  exportTrace(url: URL): Response {
    const include = sessionTraceIncludeSchema.safeParse(url.searchParams.get("include") ?? "");
    if (!include.success) {
      return Response.json(
        { error: include.error.issues[0]?.message ?? "Invalid include" },
        { status: 400 }
      );
    }

    const format = sessionTraceFormatSchema.safeParse(url.searchParams.get("format") ?? "full");
    if (!format.success) {
      return Response.json(
        { error: format.error.issues[0]?.message ?? "Invalid format" },
        { status: 400 }
      );
    }

    return Response.json(this.messageService.exportTrace(include.data, format.data));
  }
}

/** A positive integer page size up to `maxLimit`, or null when the query value is malformed. */
function parsePageLimit(
  rawLimit: string | null,
  defaultLimit: number,
  maxLimit: number
): number | null {
  const value = rawLimit ?? String(defaultLimit);
  if (!/^[1-9]\d*$/.test(value)) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit <= maxLimit ? limit : null;
}
