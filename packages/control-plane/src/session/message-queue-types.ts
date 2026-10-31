import type { SessionAttachmentReference } from "@open-inspect/shared/types/session-attachments";
import type { MessageSource } from "@open-inspect/shared/types/sessions";
import type { ParticipantRow } from "./types";
import type { EnqueuePromptRequest } from "./enqueue-prompt-contract";

export interface PromptMessageData {
  clientRequestId?: string;
  content: string;
  model?: string;
  reasoningEffort?: string;
  attachments?: SessionAttachmentReference[];
}

export interface EnqueuePromptCoreData {
  admittedCanonicalUserId?: string | null;
  mcpEligible?: boolean;
  participant: ParticipantRow;
  /** Recorded as the prompt's account in place of the participant's when set, null included. */
  promptAccountUserId?: string | null;
  userId: string;
  content: string;
  source: MessageSource;
  model?: string;
  reasoningEffort?: string;
  attachments?: SessionAttachmentReference[];
  callbackContext?: Record<string, unknown>;
  clientRequestId?: string;
  /** Stored on the participant only when the prompt is admitted, not for a retry. */
  canonicalUserId?: EnqueuePromptRequest["canonicalUserId"];
  scmEnrichment?: EnqueuePromptRequest["scmEnrichment"];
}

export interface EnqueuedPrompt {
  messageId: string;
  position: number | null;
  /** The request's clientRequestId named a prompt already queued; nothing new was added. */
  deduplicated: boolean;
}
