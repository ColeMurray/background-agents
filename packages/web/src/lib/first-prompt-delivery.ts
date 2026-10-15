import type { ReasoningEffort, ValidModel } from "@open-inspect/shared/models";
import type { SessionAttachmentReference } from "@open-inspect/shared/types/session-attachments";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { sessionActionErrorMessage } from "@/lib/session-action-error";

export interface FirstPromptDelivery {
  send(
    sessionId: string,
    prompt: {
      content: string;
      model: ValidModel;
      reasoningEffort?: ReasoningEffort;
      attachments?: SessionAttachmentReference[];
    }
  ): Promise<{ ok: true } | { ok: false; message: string; forbidden: boolean }>;
}

export const firstPromptDelivery: FirstPromptDelivery = {
  async send(sessionId, prompt) {
    const response = await browserApiFetch(`/api/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prompt),
    });
    if (response.ok) return { ok: true };
    if (response.status === 403) {
      return {
        ok: false,
        message: await sessionActionErrorMessage(response, "Failed to send prompt"),
        forbidden: true,
      };
    }
    const data = await response.json();
    return { ok: false, message: data.error || "Failed to send prompt", forbidden: false };
  },
};
