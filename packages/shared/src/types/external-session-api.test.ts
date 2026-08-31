import { describe, expect, it } from "vitest";
import {
  externalCreateSessionRequestSchema,
  externalCreateSessionResponseSchema,
  externalEventFeedQuerySchema,
  externalEventPageSchema,
  externalFollowUpRequestSchema,
  externalFollowUpResponseSchema,
} from "./external-session-api";

describe("external session API schemas", () => {
  const validCreate = {
    title: "Investigate an issue",
    model: "openai/gpt-5.6-sol",
    reasoningEffort: "high",
    initialPrompt: "Inspect the behavior",
    idempotencyKey: "create-1",
  };

  it("accepts the repository-less text create contract", () => {
    expect(externalCreateSessionRequestSchema.parse(validCreate)).toEqual(validCreate);
  });

  it.each([
    ["repoOwner", "acme"],
    ["repoName", "app"],
    ["repositories", []],
    ["environmentId", "env-1"],
    ["branch", "main"],
    ["attachments", []],
    ["skillSelection", { mode: "all" }],
    ["providerSelections", {}],
    ["provider", "openai"],
  ])("explicitly rejects unsupported create field %s", (field, value) => {
    expect(
      externalCreateSessionRequestSchema.safeParse({ ...validCreate, [field]: value }).success
    ).toBe(false);
  });

  it("rejects unknown models and model-incompatible reasoning without fallback", () => {
    expect(
      externalCreateSessionRequestSchema.safeParse({ ...validCreate, model: "unknown/model" })
        .success
    ).toBe(false);
    expect(
      externalCreateSessionRequestSchema.safeParse({
        ...validCreate,
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: "low",
      }).success
    ).toBe(false);
  });

  it("requires a nonblank text follow-up and clientRequestId", () => {
    expect(
      externalFollowUpRequestSchema.parse({
        content: "Continue",
        clientRequestId: "request-1",
        model: "openai/gpt-5.6-sol",
        reasoningEffort: "xhigh",
      })
    ).toMatchObject({ content: "Continue", clientRequestId: "request-1" });
    expect(externalFollowUpRequestSchema.safeParse({ content: "Continue" }).success).toBe(false);
    expect(
      externalFollowUpRequestSchema.safeParse({
        content: " ",
        clientRequestId: "request-1",
      }).success
    ).toBe(false);
    expect(
      externalFollowUpRequestSchema.safeParse({
        content: "Continue",
        clientRequestId: "request-1",
        attachments: [],
      }).success
    ).toBe(false);
  });

  it("requires exact success response shapes", () => {
    expect(
      externalCreateSessionResponseSchema.parse({ sessionId: "session-1", status: "created" })
    ).toEqual({ sessionId: "session-1", status: "created" });
    expect(
      externalCreateSessionResponseSchema.parse({
        sessionId: "session-1",
        messageId: "message-1",
        status: "queued",
      })
    ).toMatchObject({ status: "queued" });
    expect(
      externalCreateSessionResponseSchema.safeParse({
        sessionId: "session-1",
        status: "queued",
      }).success
    ).toBe(false);
    expect(
      externalFollowUpResponseSchema.safeParse({ messageId: "message-1", status: "running" })
        .success
    ).toBe(false);
  });

  it("requires a stable typed event envelope and pagination cursor", () => {
    const change = {
      kind: "upsert",
      revision: 1,
      event: {
        id: "event-1",
        type: "step_finish",
        messageId: "message-1",
        createdAt: 1,
        data: { type: "step_finish", tokens: { input: 3, output: 2 } },
      },
    };
    expect(
      externalEventPageSchema.safeParse({ changes: [change], checkpoint: 1, hasMore: false })
        .success
    ).toBe(true);
    expect(
      externalEventPageSchema.safeParse({ changes: [change], checkpoint: 1, hasMore: true }).success
    ).toBe(false);
    expect(
      externalEventPageSchema.safeParse({
        changes: [{ ...change, internal: true }],
        checkpoint: 1,
        hasMore: false,
      }).success
    ).toBe(false);
    expect(
      externalEventPageSchema.safeParse({
        changes: [{ kind: "delete", revision: 2, eventId: "event-1" }],
        checkpoint: 2,
        hasMore: false,
      }).success
    ).toBe(true);
  });

  it("types bounded forward event feed parameters", () => {
    expect(externalEventFeedQuerySchema.parse({ after: 12, limit: 200 })).toEqual({
      after: 12,
      limit: 200,
    });
    expect(externalEventFeedQuerySchema.safeParse({ after: -1 }).success).toBe(false);
    expect(externalEventFeedQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(externalEventFeedQuerySchema.safeParse({ after: 1, cursor: "0:1:1" }).success).toBe(
      false
    );
  });
});
