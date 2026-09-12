import type { Logger } from "../../../logger";
import { eventTypeSchema } from "@open-inspect/shared/types/sandbox-events";
import {
  enqueuePromptRequestSchema,
  type EnqueuePromptRequest,
} from "../../enqueue-prompt-contract";
import type { MessageService } from "../../services/message.service";
import { parseEventListCursor } from "../../event-cursor";
import { SessionAttachmentError } from "../../session-attachment-resolver";
import { executionStateRequestSchema } from "../../contracts";
import {
  BudgetExhaustedError,
  AutomationAdmissionExpiredError,
  PromptQueueFullError,
  HarnessModelIncompatibleError,
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
      if (error instanceof AutomationAdmissionExpiredError) {
        return Response.json(
          { error: error.message, code: "AUTOMATION_ADMISSION_EXPIRED" },
          { status: 409 }
        );
      }
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

  async reconcileExecutionState(request: Request): Promise<Response> {
    const parsed = executionStateRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "Invalid execution state request" }, { status: 400 });
    }
    return Response.json(
      await this.messageService.reconcileExecutionState(
        parsed.data.automationRunId,
        parsed.data.executionLaunchId,
        parsed.data.admissionDeadlineMs
      )
    );
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
    const cursor = url.searchParams.get("cursor");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 100);
    const status = url.searchParams.get("status");

    if (
      status &&
      !VALID_MESSAGE_STATUSES.includes(status as (typeof VALID_MESSAGE_STATUSES)[number])
    ) {
      return Response.json({ error: `Invalid message status: ${status}` }, { status: 400 });
    }

    const result = this.messageService.listMessages({ cursor, limit, status });

    return Response.json(result);
  }
}
