import { describe, expect, it } from "vitest";
import {
  externalActionPrepareRequestSchema,
  externalActionSchema,
  externalActionStatusResponseSchema,
} from "./external-actions";
import { AUDIT_OPERATION_ACTIONS } from "./audit-events";

const preparedAction = {
  id: "action_01JTEST",
  sessionId: "session-1",
  operationId: "message-1",
  toolCallId: "call-1",
  idempotencyKey: "pi:message-1:call-1",
  provider: "fake",
  action: "publish_comment",
  summary: "Publish the prepared review comment",
  target: { repository: "acme/widgets", issue: 42 },
  arguments: { body: "Looks good" },
  fingerprint: "sha256:abc",
  state: "awaiting_approval" as const,
  approval: null,
  providerReference: null,
  publicResult: null,
  error: null,
  revision: 1,
  createdAt: 1_000,
  updatedAt: 1_000,
};

describe("external action contracts", () => {
  it("accepts an immutable prepare request without credential fields", () => {
    expect(
      externalActionPrepareRequestSchema.parse({
        toolCallId: "call-1",
        idempotencyKey: "pi:message-1:call-1",
        provider: "fake",
        action: "publish_comment",
        summary: "Publish the prepared review comment",
        target: { repository: "acme/widgets", issue: 42 },
        arguments: { body: "Looks good" },
      })
    ).toMatchObject({ provider: "fake", action: "publish_comment" });

    expect(() =>
      externalActionPrepareRequestSchema.parse({
        toolCallId: "call-1",
        idempotencyKey: "pi:message-1:call-1",
        provider: "fake",
        action: "publish_comment",
        summary: "Publish",
        target: {},
        arguments: {},
        accessToken: "must-not-cross-the-boundary",
      })
    ).toThrow();

    expect(() =>
      externalActionPrepareRequestSchema.parse({
        toolCallId: "call-1",
        idempotencyKey: "pi:message-1:call-1",
        provider: "fake",
        action: "publish_comment",
        summary: "Publish",
        target: {},
        arguments: { access_token: "must-not-be-persisted" },
      })
    ).toThrow("credential-like");

    expect(() =>
      externalActionPrepareRequestSchema.parse({
        toolCallId: "call-1",
        idempotencyKey: "pi:message-1:call-1",
        provider: "fake",
        action: "publish_comment",
        summary: "Publish",
        target: {},
        arguments: { body: "x".repeat(300_000) },
      })
    ).toThrow("too large");
  });

  it("distinguishes approval, execution, and indeterminate states", () => {
    for (const state of [
      "awaiting_approval",
      "approved",
      "executing",
      "succeeded",
      "failed",
      "denied",
      "indeterminate",
      "cancelled",
    ] as const) {
      expect(externalActionSchema.parse({ ...preparedAction, state }).state).toBe(state);
    }
  });

  it("returns append-only history with the current action", () => {
    const response = externalActionStatusResponseSchema.parse({
      action: preparedAction,
      history: [
        {
          revision: 1,
          state: "awaiting_approval",
          event: "prepared",
          actorKind: "pi",
          actorId: "message-1",
          reason: null,
          occurredAt: 1_000,
        },
      ],
    });

    expect(response.history[0].event).toBe("prepared");
  });

  it("registers approval, execution, and automation-grant audit actions", () => {
    expect(AUDIT_OPERATION_ACTIONS).toEqual(
      expect.arrayContaining([
        "external_action.approved",
        "external_action.denied",
        "external_action.executed",
        "automation.external_action_grant_added",
        "automation.external_action_grant_revoked",
      ])
    );
  });
});
