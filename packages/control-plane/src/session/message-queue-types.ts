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

export interface EnqueuePromptCoreData extends Pick<
  EnqueuePromptRequest,
  "canonicalUserId" | "scmEnrichment"
> {
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
  deduplicated?: true;
}
