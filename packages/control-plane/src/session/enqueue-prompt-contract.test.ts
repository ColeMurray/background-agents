import { describe, expect, it } from "vitest";
import { enqueuePromptRequestSchema } from "./enqueue-prompt-contract";
import { sendPromptRequestSchema } from "@open-inspect/shared/types/session-api";

describe("HTTP prompt request keys", () => {
  it("keeps accepting legacy bot payloads and rejecting incomplete payloads", () => {
    expect(
      enqueuePromptRequestSchema.safeParse({
        content: "hello",
        authorId: "github:123",
        source: "github",
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: "high",
        attachments: [{ attachmentId: "attachment-1", name: "screenshot.png" }],
        callbackContext: { source: "automation", runId: "run-1" },
        scmEnrichment: { userId: "user-1", login: "octocat", name: null, email: null },
      }).success
    ).toBe(true);
    expect(
      enqueuePromptRequestSchema.safeParse({ content: "hello", authorId: "user-1" }).success
    ).toBe(false);
    expect(
      enqueuePromptRequestSchema.safeParse({
        content: "hello",
        authorId: "user-1",
        source: "unknown",
      }).success
    ).toBe(false);
  });
  it("accepts omitted and bounded keys at both boundaries", () => {
    for (const clientRequestId of [undefined, "a", "a".repeat(128)]) {
      expect(sendPromptRequestSchema.safeParse({ content: "Hi", clientRequestId }).success).toBe(
        true
      );
      expect(
        enqueuePromptRequestSchema.safeParse({
          content: "Hi",
          source: "web",
          authorId: "u",
          clientRequestId,
        }).success
      ).toBe(true);
    }
  });

  it("rejects malformed keys and keyed non-web or callback work", () => {
    for (const clientRequestId of ["", "a".repeat(129), 42]) {
      expect(sendPromptRequestSchema.safeParse({ content: "Hi", clientRequestId }).success).toBe(
        false
      );
      expect(
        enqueuePromptRequestSchema.safeParse({
          content: "Hi",
          source: "web",
          authorId: "u",
          clientRequestId,
        }).success
      ).toBe(false);
    }
    for (const body of [
      { source: "slack", clientRequestId: "key" },
      { source: "web", callbackContext: { source: "slack" }, clientRequestId: "key" },
    ]) {
      expect(
        enqueuePromptRequestSchema.safeParse({ content: "Hi", authorId: "u", ...body }).success
      ).toBe(false);
    }
  });
});
