import { describe, expect, it } from "vitest";
import {
  clientMessageSchema,
  createSessionRequestSchema,
  sandboxEventSchema,
  userPreferencesRequestSchema,
} from ".";

describe("boundary schemas", () => {
  describe("createSessionRequestSchema", () => {
    it("parses a valid session creation request", () => {
      const result = createSessionRequestSchema.safeParse({
        repoOwner: "open-inspect",
        repoName: "background-agents",
        title: "Investigate issue",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: "high",
        branch: "main",
      });

      expect(result.success).toBe(true);
    });

    it("rejects a malformed session creation request", () => {
      const result = createSessionRequestSchema.safeParse({
        repoOwner: "open-inspect",
      });

      expect(result.success).toBe(false);
    });
  });

  describe("sandboxEventSchema", () => {
    it("parses a valid tool call event", () => {
      const result = sandboxEventSchema.safeParse({
        type: "tool_call",
        tool: "bash",
        args: { command: "npm test" },
        callId: "call-1",
        status: "completed",
        output: "ok",
        messageId: "message-1",
        sandboxId: "sandbox-1",
        timestamp: 123,
      });

      expect(result.success).toBe(true);
    });

    it("rejects a malformed partial sandbox event", () => {
      const result = sandboxEventSchema.safeParse({
        type: "tool_call",
        tool: "bash",
        callId: "call-1",
        messageId: "message-1",
        sandboxId: "sandbox-1",
        timestamp: 123,
      });

      expect(result.success).toBe(false);
    });

    it("parses artifact events with omitted optional fields", () => {
      const event = {
        type: "artifact",
        artifactType: "screenshot",
        url: "sessions/session-1/media/artifact-1.png",
        sandboxId: "sandbox-1",
        timestamp: 123,
      };

      const result = sandboxEventSchema.safeParse(event);

      expect(result.success).toBe(true);
    });

    it("preserves bridge acknowledgement ids on critical events", () => {
      const result = sandboxEventSchema.safeParse({
        type: "execution_complete",
        messageId: "message-1",
        success: true,
        sandboxId: "sandbox-1",
        timestamp: 123,
        ackId: "ack-1",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ackId).toBe("ack-1");
      }
    });
  });

  describe("clientMessageSchema", () => {
    it("parses a valid prompt with attachments", () => {
      const result = clientMessageSchema.safeParse({
        type: "prompt",
        content: "Investigate the failing build",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: "high",
        attachments: [
          {
            type: "file",
            name: "error.log",
            content: "stack trace",
            mimeType: "text/plain",
          },
        ],
      });

      expect(result.success).toBe(true);
    });

    it("rejects a malformed partial subscribe message", () => {
      const result = clientMessageSchema.safeParse({
        type: "subscribe",
        token: "ws-token",
      });

      expect(result.success).toBe(false);
    });

    it("parses presence messages with an omitted cursor", () => {
      const result = clientMessageSchema.safeParse({
        type: "presence",
        status: "idle",
      });

      expect(result.success).toBe(true);
    });
  });

  describe("userPreferencesRequestSchema", () => {
    it("parses a valid user preferences request", () => {
      const result = userPreferencesRequestSchema.safeParse({
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: "high",
      });

      expect(result.success).toBe(true);
    });

    it("rejects malformed preference fields", () => {
      const result = userPreferencesRequestSchema.safeParse({
        model: 123,
      });

      expect(result.success).toBe(false);
    });
  });
});
