import { describe, expect, it } from "vitest";

import { createSessionResponseSchema, sendPromptResponseSchema } from "./control-plane-responses";

describe("control-plane response schemas", () => {
  it("parses valid session and prompt responses", () => {
    expect(
      createSessionResponseSchema.safeParse({ sessionId: "session-123", status: "running" }).success
    ).toBe(true);
    expect(sendPromptResponseSchema.safeParse({ messageId: "msg-456" }).success).toBe(true);
  });

  it("rejects malformed or partial responses", () => {
    expect(
      createSessionResponseSchema.safeParse({ sessionId: 123, status: "running" }).success
    ).toBe(false);
    expect(createSessionResponseSchema.safeParse({ sessionId: "session-123" }).success).toBe(false);
    expect(sendPromptResponseSchema.safeParse({ messageId: null }).success).toBe(false);
    expect(sendPromptResponseSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty identifiers", () => {
    expect(
      createSessionResponseSchema.safeParse({ sessionId: "", status: "running" }).success
    ).toBe(false);
    expect(
      createSessionResponseSchema.safeParse({ sessionId: "session-123", status: "" }).success
    ).toBe(false);
    expect(sendPromptResponseSchema.safeParse({ messageId: "" }).success).toBe(false);
  });
});
