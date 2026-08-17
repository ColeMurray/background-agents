import { describe, expect, it } from "vitest";
import {
  automationRepositoriesInputSchema,
  automationRepositoryInputSchema,
  clientMessageSchema,
  MAX_AUTOMATION_REPOSITORIES,
  normalizeOptionalRepositoryPair,
  RepositoryPairValidationError,
  serverMessageSchema,
  sessionAttachmentUploadResponseSchema,
} from ".";
import { sessionParticipantProfilesResponseSchema } from "./sessions";
import { listArtifactsResponseSchema } from "./artifacts";
import {
  callbackContextSchema,
  cancelChildSessionRequestSchema,
  childFollowUpPromptRequestSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  MAX_CHILD_FOLLOW_UP_PROMPT_CHARS,
  linearCompletionCallbackSchema,
  linearToolCallCallbackSchema,
  sendPromptRequestSchema,
  sendPromptResponseSchema,
  spawnChildSessionRequestSchema,
} from "./session-api";
import { MAX_WEB_PROMPT_CHARS } from "./websocket";
import {
  listEventsResponseSchema,
  sandboxEventSchema,
  toolCallIdentityKey,
} from "./sandbox-events";

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

  describe("control-plane response schemas", () => {
    it("parses valid session and prompt responses", () => {
      expect(
        createSessionResponseSchema.safeParse({
          sessionId: "session-123",
          status: "created",
        }).success
      ).toBe(true);
      expect(
        sendPromptResponseSchema.safeParse({ messageId: "msg-456", status: "queued" }).success
      ).toBe(true);
      expect(sendPromptResponseSchema.safeParse({ messageId: "msg-456" }).success).toBe(true);
    });

    it("rejects malformed or partial responses", () => {
      expect(
        createSessionResponseSchema.safeParse({ sessionId: 123, status: "created" }).success
      ).toBe(false);
      expect(createSessionResponseSchema.safeParse({ sessionId: "session-123" }).success).toBe(
        false
      );
      expect(
        createSessionResponseSchema.safeParse({
          sessionId: "session-123",
          status: "running",
        }).success
      ).toBe(false);
      expect(sendPromptResponseSchema.safeParse({ messageId: null }).success).toBe(false);
      expect(sendPromptResponseSchema.safeParse({}).success).toBe(false);
      expect(
        sendPromptResponseSchema.safeParse({ messageId: "msg-456", status: "running" }).success
      ).toBe(false);
    });

    it("rejects empty identifiers", () => {
      expect(
        createSessionResponseSchema.safeParse({ sessionId: "", status: "created" }).success
      ).toBe(false);
      expect(sendPromptResponseSchema.safeParse({ messageId: "" }).success).toBe(false);
    });
  });

  describe("sessionAttachmentUploadResponseSchema", () => {
    it("parses an upload response and ignores unknown fields", () => {
      const result = sessionAttachmentUploadResponseSchema.safeParse({
        attachmentId: "att-1",
        mimeType: "image/png",
        sizeBytes: 1024,
      });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ attachmentId: "att-1", mimeType: "image/png" });
    });

    it("rejects ids the prompt schema would reject", () => {
      // Non-empty but not a canonical id: accepting these lets a bad id reach
      // client state and fail later, at prompt validation.
      expect(
        sessionAttachmentUploadResponseSchema.safeParse({
          attachmentId: "bad id",
          mimeType: "image/png",
        }).success
      ).toBe(false);
      expect(
        sessionAttachmentUploadResponseSchema.safeParse({
          attachmentId: "a".repeat(129),
          mimeType: "image/png",
        }).success
      ).toBe(false);
      expect(
        sessionAttachmentUploadResponseSchema.safeParse({ attachmentId: "", mimeType: "image/png" })
          .success
      ).toBe(false);
    });

    it("rejects unsupported or missing mime types", () => {
      expect(
        sessionAttachmentUploadResponseSchema.safeParse({
          attachmentId: "att-1",
          mimeType: "application/pdf",
        }).success
      ).toBe(false);
      expect(
        sessionAttachmentUploadResponseSchema.safeParse({ attachmentId: "att-1" }).success
      ).toBe(false);
    });
  });

  describe("completion response schemas", () => {
    it("parses valid event and artifact list responses", () => {
      expect(
        listEventsResponseSchema.safeParse({
          events: [
            {
              id: "event-1",
              type: "token",
              data: { content: "hello" },
              messageId: "msg-1",
              createdAt: 123,
            },
          ],
          cursor: "next-page",
          hasMore: true,
        }).success
      ).toBe(true);
      expect(
        listArtifactsResponseSchema.safeParse({
          artifacts: [
            {
              id: "artifact-1",
              type: "branch",
              url: "https://example.com/tree/main",
              metadata: { head: "main" },
              createdAt: 123,
            },
          ],
        }).success
      ).toBe(true);
    });

    it("rejects malformed or partial completion responses", () => {
      expect(
        listEventsResponseSchema.safeParse({
          events: [{ id: "event-1", type: "token", data: {}, messageId: "msg-1" }],
          hasMore: false,
        }).success
      ).toBe(false);
      expect(
        listArtifactsResponseSchema.safeParse({
          artifacts: [{ id: "artifact-1", type: "branch", url: null }],
        }).success
      ).toBe(false);
    });

    it("rejects an events page that reports more results without a cursor", () => {
      const page = {
        events: [
          {
            id: "event-1",
            type: "token",
            data: { content: "hello" },
            messageId: "msg-1",
            createdAt: 123,
          },
        ],
        hasMore: true,
      };

      expect(listEventsResponseSchema.safeParse(page).success).toBe(false);
      expect(listEventsResponseSchema.safeParse({ ...page, cursor: "" }).success).toBe(false);
      expect(listEventsResponseSchema.safeParse({ ...page, cursor: "next-page" }).success).toBe(
        true
      );
    });

    it("preserves updatedAt on listed artifacts", () => {
      const parsed = listArtifactsResponseSchema.safeParse({
        artifacts: [
          {
            id: "artifact-1",
            type: "pr",
            url: "https://example.com/pull/1",
            metadata: { number: 1 },
            createdAt: 123,
            updatedAt: 456,
          },
        ],
      });

      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.artifacts[0].updatedAt).toBe(456);
    });

    it("accepts nullable boundary fields returned by the control plane", () => {
      expect(
        listEventsResponseSchema.safeParse({
          events: [
            {
              id: "event-1",
              type: "execution_complete",
              data: { success: true },
              messageId: null,
              createdAt: 123,
            },
          ],
          hasMore: false,
        }).success
      ).toBe(true);
      expect(
        listArtifactsResponseSchema.safeParse({
          artifacts: [
            {
              id: "artifact-1",
              type: "branch",
              url: null,
              metadata: null,
              createdAt: 123,
            },
          ],
        }).success
      ).toBe(true);
    });
  });

  describe("sendPromptRequestSchema", () => {
    it("parses a valid prompt request with a Slack callback context", () => {
      const result = sendPromptRequestSchema.safeParse({
        content: "Investigate the failure",
        source: "slack",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: "high",
        attachments: [{ attachmentId: "att-1", name: "screenshot.png" }],
        callbackContext: {
          source: "slack",
          channel: "C123",
          threadTs: "1710000000.000100",
          repoFullName: "open-inspect/background-agents",
          model: "anthropic/claude-sonnet-4-6",
          reactionMessageTs: "1710000000.000200",
        },
      });

      expect(result.success).toBe(true);
    });

    it("rejects a malformed prompt request", () => {
      expect(sendPromptRequestSchema.safeParse({ content: 123 }).success).toBe(false);
      expect(sendPromptRequestSchema.safeParse({ source: "web" }).success).toBe(false);
      expect(sendPromptRequestSchema.safeParse({ content: "" }).success).toBe(false);
      expect(
        sendPromptRequestSchema.safeParse({ content: "hello", source: "unknown" }).success
      ).toBe(false);
    });
  });

  describe("childFollowUpPromptRequestSchema", () => {
    it("accepts non-empty content through the documented limit", () => {
      expect(
        childFollowUpPromptRequestSchema.safeParse({ content: "Continue with the failing tests" })
          .success
      ).toBe(true);
      expect(
        childFollowUpPromptRequestSchema.safeParse({
          content: "x".repeat(MAX_CHILD_FOLLOW_UP_PROMPT_CHARS),
        }).success
      ).toBe(true);
    });

    it("rejects empty, whitespace-only, and oversized content", () => {
      expect(childFollowUpPromptRequestSchema.safeParse({ content: "" }).success).toBe(false);
      expect(childFollowUpPromptRequestSchema.safeParse({ content: " \n\t " }).success).toBe(false);
      expect(
        childFollowUpPromptRequestSchema.safeParse({
          content: "x".repeat(MAX_CHILD_FOLLOW_UP_PROMPT_CHARS + 1),
        }).success
      ).toBe(false);
    });

    it("rejects fields that expand the parent sandbox authority", () => {
      for (const extra of [
        { source: "web" },
        { authorId: "forged" },
        { model: "openai/gpt-5.4" },
        { attachments: [] },
        { callbackContext: {} },
      ]) {
        expect(
          childFollowUpPromptRequestSchema.safeParse({ content: "Continue", ...extra }).success
        ).toBe(false);
      }
    });
  });

  describe("callbackContextSchema", () => {
    it("parses valid callback contexts", () => {
      expect(
        callbackContextSchema.safeParse({
          source: "slack",
          channel: "C123",
          threadTs: "1710000000.000100",
          repoFullName: "open-inspect/background-agents",
          model: "anthropic/claude-sonnet-4-6",
        }).success
      ).toBe(true);
      expect(
        callbackContextSchema.safeParse({
          source: "linear",
          issueId: "issue-1",
          issueIdentifier: "OI-123",
          issueUrl: "https://linear.app/open-inspect/issue/OI-123/test",
          repoFullName: "open-inspect/background-agents",
          model: "anthropic/claude-sonnet-4-6",
          transitionIssueOnStart: false,
        }).success
      ).toBe(true);
      expect(
        callbackContextSchema.safeParse({
          source: "automation",
          automationId: "automation-1",
          runId: "run-1",
          automationName: "Nightly sweep",
        }).success
      ).toBe(true);
    });

    it("rejects malformed or partial callback contexts", () => {
      expect(callbackContextSchema.safeParse({ source: "slack", channel: "C123" }).success).toBe(
        false
      );
      expect(
        callbackContextSchema.safeParse({
          source: "automation",
          automationId: "automation-1",
          runId: null,
          automationName: "Nightly sweep",
        }).success
      ).toBe(false);
      expect(callbackContextSchema.safeParse({ source: "github" }).success).toBe(false);
    });
  });

  describe("Linear callback schemas", () => {
    const context = {
      source: "linear",
      issueId: "issue-1",
      issueIdentifier: "OI-123",
      issueUrl: "https://linear.app/open-inspect/issue/OI-123/test",
      model: "anthropic/claude-sonnet-4-6",
    };

    it("requires a complete completion callback and valid Linear context", () => {
      const callback = {
        sessionId: "session-1",
        messageId: "message-1",
        success: true,
        timestamp: 123,
        context,
        signature: "signature",
      };

      expect(linearCompletionCallbackSchema.safeParse(callback).success).toBe(true);
      expect(
        linearCompletionCallbackSchema.safeParse({
          ...callback,
          context: { source: "linear", issueId: "issue-1" },
        }).success
      ).toBe(false);
    });

    it("requires tool args and callId", () => {
      const callback = {
        sessionId: "session-1",
        tool: "bash",
        args: { command: "npm test" },
        callId: "call-1",
        timestamp: 123,
        context,
        signature: "signature",
      };

      expect(linearToolCallCallbackSchema.safeParse(callback).success).toBe(true);
      const { args: _args, ...withoutArgs } = callback;
      expect(linearToolCallCallbackSchema.safeParse(withoutArgs).success).toBe(false);
      expect(linearToolCallCallbackSchema.safeParse({ ...callback, callId: "" }).success).toBe(
        false
      );
      expect(linearToolCallCallbackSchema.safeParse({ ...callback, tool: "" }).success).toBe(false);
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

    it("preserves task activity correlation fields", () => {
      const taskResult = sandboxEventSchema.safeParse({
        type: "tool_call",
        tool: "task",
        args: { description: "Review code" },
        callId: "task-call-1",
        status: "completed",
        messageId: "message-1",
        sandboxId: "sandbox-1",
        timestamp: 123,
        childSessionId: "child-session-1",
      });
      const childResult = sandboxEventSchema.safeParse({
        type: "tool_call",
        tool: "bash",
        args: { command: "npm test" },
        callId: "child-call-1",
        status: "completed",
        messageId: "message-1",
        sandboxId: "sandbox-1",
        timestamp: 124,
        isSubtask: true,
        childSessionId: "child-session-1",
        taskCallId: "task-call-1",
      });
      const errorResult = sandboxEventSchema.safeParse({
        type: "error",
        error: "Child failed",
        messageId: "message-1",
        sandboxId: "sandbox-1",
        timestamp: 125,
        isSubtask: true,
        childSessionId: "child-session-1",
        taskCallId: "task-call-1",
      });

      expect(taskResult.success && taskResult.data.childSessionId).toBe("child-session-1");
      expect(childResult.success && childResult.data).toMatchObject({
        isSubtask: true,
        childSessionId: "child-session-1",
        taskCallId: "task-call-1",
      });
      expect(errorResult.success && errorResult.data).toMatchObject({
        isSubtask: true,
        childSessionId: "child-session-1",
        taskCallId: "task-call-1",
      });
    });

    it("uses task ownership when a child session ID is unavailable", () => {
      const base = {
        type: "tool_call" as const,
        tool: "bash",
        args: {},
        callId: "shared-call",
        messageId: "message-1",
        isSubtask: true,
      };

      expect(toolCallIdentityKey({ ...base, taskCallId: "task-1" })).not.toBe(
        toolCallIdentityKey({ ...base, taskCallId: "task-2" })
      );
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

    it("parses a ready event (emitted on every sandbox connect)", () => {
      const result = sandboxEventSchema.safeParse({
        type: "ready",
        sandboxId: "sandbox-1",
        opencodeSessionId: null,
        timestamp: 123,
      });

      expect(result.success).toBe(true);
    });

    it("parses context compaction events with required message association", () => {
      const event = {
        type: "context_compacted",
        messageId: "message-1",
        sandboxId: "sandbox-1",
        timestamp: 123,
      };

      expect(sandboxEventSchema.safeParse(event)).toEqual(
        expect.objectContaining({ success: true, data: event })
      );
      expect(sandboxEventSchema.safeParse({ ...event, messageId: undefined }).success).toBe(false);
      expect(sandboxEventSchema.safeParse({ ...event, sandboxId: undefined }).success).toBe(false);
      expect(sandboxEventSchema.safeParse({ ...event, timestamp: undefined }).success).toBe(false);
    });
  });

  describe("clientMessageSchema", () => {
    it("parses a valid prompt with attachments and request correlation", () => {
      const result = clientMessageSchema.safeParse({
        type: "prompt",
        clientRequestId: "0190cc3e-95ca-7dd8-b0a7-55ca8456ee31",
        content: "Investigate the failing build",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: "high",
        attachments: [
          {
            name: "error.png",
            attachmentId: "attachment-1",
          },
        ],
      });

      expect(result.success).toBe(true);
    });

    it("requires clientRequestId for prompt correlation", () => {
      expect(clientMessageSchema.safeParse({ type: "prompt", content: "Continue" }).success).toBe(
        false
      );
    });

    it("parses correlated queued prompt cancellation", () => {
      expect(
        clientMessageSchema.parse({
          type: "cancel_prompt",
          messageId: "message-1",
          clientRequestId: "request-1",
        })
      ).toMatchObject({ messageId: "message-1", clientRequestId: "request-1" });
      expect(
        clientMessageSchema.safeParse({
          type: "cancel_prompt",
          messageId: "",
          clientRequestId: "request-1",
        }).success
      ).toBe(false);
    });

    it("rejects invalid prompt request correlation identifiers", () => {
      expect(
        clientMessageSchema.safeParse({ type: "prompt", content: "Continue", clientRequestId: "" })
          .success
      ).toBe(false);
      expect(
        clientMessageSchema.safeParse({
          type: "prompt",
          content: "Continue",
          clientRequestId: "x".repeat(129),
        }).success
      ).toBe(false);
    });

    it("rejects blank and oversized prompts but accepts attachment-only prompts", () => {
      expect(clientMessageSchema.safeParse({ type: "prompt", content: "  \n" }).success).toBe(
        false
      );
      expect(
        clientMessageSchema.safeParse({
          type: "prompt",
          clientRequestId: "request-oversized",
          content: "x".repeat(MAX_WEB_PROMPT_CHARS + 1),
        }).success
      ).toBe(false);
      expect(
        clientMessageSchema.safeParse({
          type: "prompt",
          clientRequestId: "request-attachment-only",
          content: " \n",
          attachments: [{ name: "evidence.png", attachmentId: "attachment-1" }],
        }).success
      ).toBe(true);
    });

    it("rejects inline and remote attachment sources", () => {
      for (const attachment of [
        { name: "inline.png", content: "aGVsbG8=" },
        { name: "remote.png", url: "https://example.com/remote.png" },
      ]) {
        const result = clientMessageSchema.safeParse({
          type: "prompt",
          clientRequestId: "request-source",
          content: "Look",
          attachments: [attachment],
        });
        expect(result.success).toBe(false);
      }
    });

    it("rejects prompts with more than six attachments", () => {
      const result = clientMessageSchema.safeParse({
        type: "prompt",
        clientRequestId: "request-attachments",
        content: "Compare these",
        attachments: Array.from({ length: 7 }, (_, index) => ({
          name: `${index}.png`,
          attachmentId: `upload-${index}`,
        })),
      });

      expect(result.success).toBe(false);
    });

    it("bounds attachment identifiers and names", () => {
      for (const attachment of [
        { name: "shot.png", attachmentId: "../upload" },
        { name: "x".repeat(256), attachmentId: "attachment-1" },
      ]) {
        expect(
          clientMessageSchema.safeParse({
            type: "prompt",
            clientRequestId: "request-attachment-bounds",
            content: "Look",
            attachments: [attachment],
          }).success
        ).toBe(false);
      }
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
        session: {
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
        promptQueue: [],
        timeline: {
          events: [],
          hasMore: false,
          cursor: null,
        },
        spawnError: null,
      });

      expect(result.success).toBe(true);
    });

    it("accepts subscribed snapshots", () => {
      const result = serverMessageSchema.safeParse({
        type: "subscribed",
        session: {
          id: "session-1",
          title: null,
          repoOwner: null,
          repoName: null,
          baseBranch: null,
          branchName: null,
          status: "active",
          sandboxStatus: "ready",
          messageCount: 0,
          createdAt: 123,
        },
        artifacts: [],
        participantId: "participant-1",
        promptQueue: [],
        timeline: { events: [], hasMore: false, cursor: null },
      });

      expect(result.success).toBe(true);
    });

    it("keeps recognized timeline events and drops unknown ones without failing", () => {
      const result = serverMessageSchema.safeParse({
        type: "subscribed",
        session: {
          id: "session-1",
          title: null,
          repoOwner: null,
          repoName: null,
          baseBranch: null,
          branchName: null,
          status: "completed",
          sandboxStatus: "stopped",
          messageCount: 1,
          createdAt: 123,
          parentSessionId: null,
          tunnelUrls: null,
        },
        artifacts: [],
        participantId: "participant-1",
        promptQueue: [],
        timeline: {
          events: [
            {
              eventId: "event-1",
              timelineSequence: 1,
              event: { type: "ready", sandboxId: "sandbox-1", timestamp: 1 },
            },
            { eventId: "event-2", timelineSequence: 2, event: { type: "future" } },
            {
              eventId: "event-3",
              timelineSequence: 3,
              event: {
                type: "token",
                content: "hi",
                messageId: "m1",
                sandboxId: "sandbox-1",
                timestamp: 3,
              },
            },
          ],
          hasMore: false,
          cursor: null,
        },
        spawnError: null,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeline.events.map((item) => item.event.type)).toEqual([
          "ready",
          "token",
        ]);
      }
    });

    it("keeps recognized history_page items and drops unknown ones without failing", () => {
      const result = serverMessageSchema.safeParse({
        type: "history_page",
        items: [
          { eventId: "event-1", timelineSequence: 1, event: { type: "future" } },
          {
            eventId: "event-2",
            timelineSequence: 2,
            event: {
              type: "git_sync",
              status: "completed",
              sandboxId: "sandbox-1",
              timestamp: 2,
            },
          },
        ],
        hasMore: false,
        cursor: null,
      });

      expect(result.success).toBe(true);
      if (result.success && result.data.type === "history_page") {
        expect(result.data.items.map((item) => item.event.type)).toEqual(["git_sync"]);
      }
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

    it("accepts context compaction events in live messages and timeline hydration", () => {
      const event = {
        type: "context_compacted",
        messageId: "message-1",
        sandboxId: "sandbox-1",
        timestamp: 123,
      };

      expect(serverMessageSchema.safeParse({ type: "sandbox_event", event }).success).toBe(true);

      const history = serverMessageSchema.safeParse({
        type: "history_page",
        items: [{ eventId: "event-1", timelineSequence: 1, event }],
        hasMore: false,
        cursor: null,
      });
      expect(history.success).toBe(true);
      if (history.success && history.data.type === "history_page") {
        expect(history.data.items).toEqual([{ eventId: "event-1", timelineSequence: 1, event }]);
      }

      const subscribed = serverMessageSchema.safeParse({
        type: "subscribed",
        session: {
          id: "session-1",
          title: null,
          repoOwner: null,
          repoName: null,
          baseBranch: null,
          branchName: null,
          status: "completed",
          sandboxStatus: "stopped",
          messageCount: 1,
          createdAt: 123,
        },
        artifacts: [],
        participantId: "participant-1",
        promptQueue: [],
        timeline: {
          events: [{ eventId: "event-1", timelineSequence: 1, event }],
          hasMore: false,
          cursor: null,
        },
      });
      expect(subscribed.success).toBe(true);
      if (subscribed.success && subscribed.data.type === "subscribed") {
        expect(subscribed.data.timeline.events).toEqual([
          { eventId: "event-1", timelineSequence: 1, event },
        ]);
      }
    });

    it("rejects an unknown message type", () => {
      const result = serverMessageSchema.safeParse({ type: "unexpected" });

      expect(result.success).toBe(false);
    });
  });

  describe("participant profile boundaries", () => {
    it("parses only safe profile fields keyed by canonical user ID", () => {
      const result = sessionParticipantProfilesResponseSchema.parse({
        profiles: {
          "user-1": {
            userId: "user-1",
            displayName: "Ada Lovelace",
            avatarUrl: "https://avatars.example/ada",
            email: "private@example.com",
          },
        },
      });

      expect(result).toEqual({
        profiles: {
          "user-1": {
            userId: "user-1",
            displayName: "Ada Lovelace",
            avatarUrl: "https://avatars.example/ada",
          },
        },
      });
    });

    it("accepts historical user messages without an author userId", () => {
      const legacy = sandboxEventSchema.safeParse({
        type: "user_message",
        content: "hello",
        messageId: "message-1",
        timestamp: 1,
        author: { participantId: "participant-1", name: "Legacy User" },
      });
      const current = sandboxEventSchema.safeParse({
        type: "user_message",
        content: "hello",
        messageId: "message-2",
        timestamp: 1,
        author: { participantId: "participant-1", userId: "user-1", name: "Ada" },
      });

      expect(legacy.success).toBe(true);
      expect(current.success).toBe(true);
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

  describe("cancelChildSessionRequestSchema", () => {
    it("parses an empty options object", () => {
      const result = cancelChildSessionRequestSchema.safeParse({});

      expect(result.success).toBe(true);
    });

    it("parses an explicit cancelNested flag", () => {
      const result = cancelChildSessionRequestSchema.safeParse({ cancelNested: false });

      expect(result.success).toBe(true);
    });

    it("rejects a non-boolean cancelNested", () => {
      const result = cancelChildSessionRequestSchema.safeParse({ cancelNested: "yes" });

      expect(result.success).toBe(false);
    });
  });
});

describe("automation repository schemas", () => {
  describe("normalizeOptionalRepositoryPair", () => {
    it("trims and lowercases a complete pair", () => {
      expect(
        normalizeOptionalRepositoryPair({ repoOwner: "  Acme  ", repoName: "  Web-App " })
      ).toEqual({
        repoOwner: "acme",
        repoName: "web-app",
      });
    });

    it("maps an absent pair to null", () => {
      expect(normalizeOptionalRepositoryPair({})).toBeNull();
      expect(normalizeOptionalRepositoryPair({ repoOwner: null, repoName: null })).toBeNull();
      expect(normalizeOptionalRepositoryPair({ repoOwner: "   ", repoName: "" })).toBeNull();
    });

    it("throws RepositoryPairValidationError on a half pair", () => {
      expect(() => normalizeOptionalRepositoryPair({ repoOwner: "acme" })).toThrow(
        RepositoryPairValidationError
      );
      expect(() => normalizeOptionalRepositoryPair({ repoOwner: "  ", repoName: "web" })).toThrow(
        "repoOwner and repoName must be provided together"
      );
    });

    it("uses the provided message for half pairs", () => {
      expect(() => normalizeOptionalRepositoryPair({ repoName: "web" }, "custom message")).toThrow(
        "custom message"
      );
    });
  });

  describe("automationRepositoryInputSchema", () => {
    it("normalizes identifiers and defaults baseBranch to null", () => {
      const result = automationRepositoryInputSchema.safeParse({
        repoOwner: " Acme ",
        repoName: " Web-App ",
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ repoOwner: "acme", repoName: "web-app", baseBranch: null });
    });

    it("keeps a trimmed baseBranch", () => {
      const result = automationRepositoryInputSchema.safeParse({
        repoOwner: "acme",
        repoName: "web",
        baseBranch: " develop ",
      });

      expect(result.success).toBe(true);
      expect(result.data?.baseBranch).toBe("develop");
    });

    it("rejects empty identifiers", () => {
      expect(
        automationRepositoryInputSchema.safeParse({ repoOwner: "", repoName: "web" }).success
      ).toBe(false);
      expect(
        automationRepositoryInputSchema.safeParse({ repoOwner: "acme", repoName: "  " }).success
      ).toBe(false);
    });

    it("rejects a whitespace-only baseBranch", () => {
      const result = automationRepositoryInputSchema.safeParse({
        repoOwner: "acme",
        repoName: "web",
        baseBranch: "   ",
      });

      expect(result.success).toBe(false);
    });
  });

  describe("automationRepositoriesInputSchema", () => {
    it("accepts an empty list and a single repository", () => {
      expect(automationRepositoriesInputSchema.safeParse([]).success).toBe(true);
      expect(
        automationRepositoriesInputSchema.safeParse([{ repoOwner: "acme", repoName: "web" }])
          .success
      ).toBe(true);
    });

    it("rejects more than MAX_AUTOMATION_REPOSITORIES entries", () => {
      const repositories = Array.from({ length: MAX_AUTOMATION_REPOSITORIES + 1 }, (_, i) => ({
        repoOwner: "acme",
        repoName: `repo-${i}`,
      }));

      expect(automationRepositoriesInputSchema.safeParse(repositories).success).toBe(false);
    });

    it("accepts exactly MAX_AUTOMATION_REPOSITORIES entries", () => {
      const repositories = Array.from({ length: MAX_AUTOMATION_REPOSITORIES }, (_, i) => ({
        repoOwner: "acme",
        repoName: `repo-${i}`,
      }));

      expect(automationRepositoriesInputSchema.safeParse(repositories).success).toBe(true);
    });

    it("rejects case-insensitive duplicate repositories", () => {
      const result = automationRepositoriesInputSchema.safeParse([
        { repoOwner: "Acme", repoName: "Web" },
        { repoOwner: "acme", repoName: "web" },
      ]);

      expect(result.success).toBe(false);
    });

    it("accepts the same repository name under different owners", () => {
      const result = automationRepositoriesInputSchema.safeParse([
        { repoOwner: "acme", repoName: "web" },
        { repoOwner: "globex", repoName: "web" },
      ]);

      expect(result.success).toBe(true);
    });
  });
});
