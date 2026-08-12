import { describe, expect, it, vi } from "vitest";
import { promptRequestSignature, resolvePromptRequestIdentity } from "@/lib/prompt-request-id";
import { getPromptSubmissionDisabledMessage } from "@/lib/prompt-submission-capability";

describe("session page prompt request identity", () => {
  it("reuses the request ID for an unchanged retry and replaces it after draft settings change", () => {
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("request-1")
      .mockReturnValueOnce("request-2");
    const signature = promptRequestSignature({
      content: "Follow up",
      model: "model-1",
      reasoningEffort: "high",
      attachmentIds: ["attachment-1"],
    });

    const first = resolvePromptRequestIdentity(signature, null);
    expect(resolvePromptRequestIdentity(signature, first)).toBe(first);

    const changed = resolvePromptRequestIdentity(
      promptRequestSignature({
        content: "Follow up changed",
        model: "model-1",
        reasoningEffort: "high",
        attachmentIds: ["attachment-1"],
      }),
      first
    );
    expect(changed.clientRequestId).toBe("request-2");
  });
});

describe("session page rolling deployment gate", () => {
  it("keeps old subscribed servers from entering the correlated retry flow", () => {
    expect(getPromptSubmissionDisabledMessage(true, false)).toMatch(/newer server version/i);
    expect(getPromptSubmissionDisabledMessage(true, true)).toBeNull();
  });
});
