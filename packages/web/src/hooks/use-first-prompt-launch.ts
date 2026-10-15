"use client";

import { useRef, useState } from "react";
import type { ReasoningEffort, ValidModel } from "@open-inspect/shared/models";
import type { SessionAttachmentReference } from "@open-inspect/shared/types/session-attachments";
import { DEFAULT_ATTACHMENT_ONLY_MESSAGE } from "@/hooks/use-session-attachments";
import type { FirstPromptDelivery } from "@/lib/first-prompt-delivery";

interface FirstPromptLaunch {
  prompt: string;
  model: ValidModel;
  reasoningEffort?: ReasoningEffort;
  hasAttachments: boolean;
  blocked: boolean;
  validationError: string | null;
}

interface FirstPromptCollaborators {
  sessions: {
    /** Reuses or acquires the current warm session; null means it cannot be used. */
    warm(): Promise<string | null>;
    consume(sessionId: string): void;
  };
  attachments: {
    /** Owns upload errors and retains pending files for retry on failure. */
    uploadAll(sessionId: string): Promise<SessionAttachmentReference[]>;
  };
  delivery: FirstPromptDelivery;
  completion: {
    /** Clears submitted composer state and performs the application's success handoff. */
    launched(sessionId: string, submittedPrompt: string): void;
    denied(message: string): void;
  };
}

/** One first-prompt transaction at a time; render updates cannot replace its captured inputs. */
export function useFirstPromptLaunch(
  input: FirstPromptLaunch,
  collaborators: FirstPromptCollaborators
) {
  const inFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (inFlight.current || input.blocked || (!input.prompt.trim() && !input.hasAttachments))
      return;
    if (input.validationError) {
      setError(input.validationError);
      return;
    }

    inFlight.current = true;
    setSubmitting(true);
    setError("");
    const { sessions, attachments, delivery, completion } = collaborators;
    try {
      const sessionId = await sessions.warm();
      if (!sessionId) {
        setError("Failed to create session");
        return;
      }

      let uploaded: SessionAttachmentReference[] | undefined;
      if (input.hasAttachments) {
        try {
          uploaded = await attachments.uploadAll(sessionId);
        } catch {
          return;
        }
      }

      const result = await delivery.send(sessionId, {
        content: input.prompt.trim() || DEFAULT_ATTACHMENT_ONLY_MESSAGE,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        ...(uploaded?.length ? { attachments: uploaded } : {}),
      });
      if (!result.ok) {
        if (result.forbidden) completion.denied(result.message);
        setError(result.message);
        return;
      }

      sessions.consume(sessionId);
      // Attachment editing stays locked for the transaction; the draft owner compares text.
      completion.launched(sessionId, input.prompt);
    } catch {
      setError("Failed to create session");
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return { submit, submitting, error };
}
