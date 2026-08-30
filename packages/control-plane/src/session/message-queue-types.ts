import type { SessionAttachmentReference } from "@open-inspect/shared/types/session-attachments";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { MessageSource } from "@open-inspect/shared/types/sessions";
import type { RecordedMessageCompletion } from "./message-repository";
import type { ParticipantRow } from "./types";

export interface PromptMessageData {
  clientRequestId?: string;
  content: string;
  model?: string;
  reasoningEffort?: string;
  attachments?: SessionAttachmentReference[];
}

export interface StopExecutionOptions {
  suppressStatusReconcile?: boolean;
  reason?: string;
}

export interface RecordedMessageFailure {
  event: Extract<SandboxEvent, { type: "execution_complete" }>;
  completion: RecordedMessageCompletion;
}

export interface BudgetStopPreparation {
  stopped: boolean;
  processingMessageId: string | null;
  stopConfirmationDeadline: number | null;
  failure: RecordedMessageFailure | null;
}

export interface EnqueuePromptCoreData {
  participant: ParticipantRow;
  userId: string;
  content: string;
  source: MessageSource;
  model?: string;
  reasoningEffort?: string;
  attachments?: SessionAttachmentReference[];
  callbackContext?: Record<string, unknown>;
  clientRequestId?: string;
}

export interface EnqueuedPrompt {
  messageId: string;
  position: number | null;
}
