import { describe, expect, it } from "vitest";

import { createSessionResponseSchema, sendPromptResponseSchema } from "./control-plane-responses";

describe("control-plane response schemas", () => {
  it("parses valid session and prompt responses", () => {
    expect(createSessionResponseSchema.safeParse({ sessionId: "session-123" }).success).toBe(true);
    expect(sendPromptResponseSchema.safeParse({ messageId: "msg-456" }).success).toBe(true);
  });

  it("rejects malformed or partial responses", () => {
    expect(createSessionResponseSchema.safeParse({ sessionId: 123 }).success).toBe(false);
    expect(createSessionResponseSchema.safeParse({}).success).toBe(false);
    expect(sendPromptResponseSchema.safeParse({ messageId: null }).success).toBe(false);
    expect(sendPromptResponseSchema.safeParse({}).success).toBe(false);
  });
});
