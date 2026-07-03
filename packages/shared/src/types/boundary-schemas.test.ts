import { describe, expect, it } from "vitest";
import {
  clientMessageSchema,
  createSessionRequestSchema,
  sandboxEventSchema,
  serverMessageSchema,
  spawnChildSessionRequestSchema,
  spawnContextSchema,
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

    it("parses a valid repo-less session creation request", () => {
      const result = createSessionRequestSchema.safeParse({
        title: "Incident sweep",
        model: "anthropic/claude-sonnet-4-6",
      });

      expect(result.success).toBe(true);
    });

    it("rejects a partial repository session creation request", () => {
      const result = createSessionRequestSchema.safeParse({
        repoOwner: "open-inspect",
      });

      expect(result.success).toBe(false);
    });

    it("rejects a whitespace-only partial repository session creation request", () => {
      const result = createSessionRequestSchema.safeParse({
        repoOwner: "   ",
        repoName: "background-agents",
      });

      expect(result.success).toBe(false);
    });

    it("rejects whitespace-only repository identifiers", () => {
      const result = createSessionRequestSchema.safeParse({
        repoOwner: "   ",
        repoName: "\t",
      });

      expect(result.success).toBe(false);
    });

    it("rejects empty-string repository identifiers instead of coercing to repo-less", () => {
      const result = createSessionRequestSchema.safeParse({
        repoOwner: "",
        repoName: "",
      });

      expect(result.success).toBe(false);
    });

    it("rejects branch without repository context", () => {
      const result = createSessionRequestSchema.safeParse({
        title: "Incident sweep",
        branch: "main",
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

    it("parses step finish events with structured token usage", () => {
      const tokenUsage = {
        total: 223,
        input: 219,
        output: 4,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      };

      const result = sandboxEventSchema.safeParse({
        type: "step_finish",
        messageId: "message-1",
        cost: 0.001,
        tokens: tokenUsage,
        reason: "end_turn",
        sandboxId: "sandbox-1",
        timestamp: 123,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tokens).toEqual(tokenUsage);
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

    it("parses fetch history messages with an omitted cursor", () => {
      const result = clientMessageSchema.safeParse({
        type: "fetch_history",
      });

      expect(result.success).toBe(true);
    });
  });

  describe("serverMessageSchema", () => {
    it("parses a valid subscribed message with nullable fields", () => {
      const result = serverMessageSchema.safeParse({
        type: "subscribed",
        sessionId: "session-1",
        state: {
          id: "session-1",
          title: null,
          repoOwner: null,
          repoName: null,
          baseBranch: null,
          branchName: null,
          status: "active",
          sandboxStatus: "ready",
          messageCount: 1,
          createdAt: 123,
          parentSessionId: null,
          tunnelUrls: null,
        },
        artifacts: [
          {
            id: "artifact-1",
            type: "screenshot",
            url: null,
            metadata: null,
            createdAt: 124,
          },
        ],
        participantId: "participant-1",
        replay: {
          events: [],
          hasMore: false,
          cursor: null,
        },
        spawnError: null,
      });

      expect(result.success).toBe(true);
    });

    it("rejects a malformed partial sandbox event message", () => {
      const result = serverMessageSchema.safeParse({
        type: "sandbox_event",
        event: {
          type: "token",
          content: "hello",
          sandboxId: "sandbox-1",
          timestamp: 123,
        },
      });

      expect(result.success).toBe(false);
    });

    it("rejects an unknown message type", () => {
      const result = serverMessageSchema.safeParse({ type: "unexpected" });

      expect(result.success).toBe(false);
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

  describe("spawnChildSessionRequestSchema", () => {
    it("parses a valid child session request", () => {
      const result = spawnChildSessionRequestSchema.safeParse({
        title: "Investigate failure",
        prompt: "Find and fix the failing test",
        repoOwner: "open-inspect",
        repoName: "background-agents",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: "high",
      });

      expect(result.success).toBe(true);
    });

    it("rejects a malformed partial child session request", () => {
      const result = spawnChildSessionRequestSchema.safeParse({
        title: "Missing prompt",
      });

      expect(result.success).toBe(false);
    });
  });

  describe("spawnContextSchema", () => {
    it("parses a valid spawn context with nullable fields", () => {
      const result = spawnContextSchema.safeParse({
        repoOwner: "open-inspect",
        repoName: "background-agents",
        repoId: null,
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: null,
        baseBranch: null,
        owner: {
          userId: "user-1",
          scmUserId: null,
          scmLogin: null,
          scmName: null,
          scmEmail: null,
          scmAccessTokenEncrypted: null,
          scmRefreshTokenEncrypted: null,
          scmTokenExpiresAt: null,
        },
      });

      expect(result.success).toBe(true);
    });

    it("parses a repo-less spawn context", () => {
      const result = spawnContextSchema.safeParse({
        repoOwner: null,
        repoName: null,
        repoId: null,
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: null,
        baseBranch: null,
        owner: {
          userId: "user-1",
          scmUserId: null,
          scmLogin: null,
          scmName: null,
          scmEmail: null,
          scmAccessTokenEncrypted: null,
          scmRefreshTokenEncrypted: null,
          scmTokenExpiresAt: null,
        },
      });

      expect(result.success).toBe(true);
    });

    it("rejects a malformed partial spawn context", () => {
      const result = spawnContextSchema.safeParse({
        repoOwner: "open-inspect",
        repoName: "background-agents",
      });

      expect(result.success).toBe(false);
    });
  });
});
