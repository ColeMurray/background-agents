import { describe, expect, it } from "vitest";
import {
  createSlackCompletionJob,
  slackCompletionDeliveryId,
  slackCompletionJobSchema,
} from "./job";

const context = { repoFullName: "acme/app", model: "anthropic/claude-haiku-4-5" };

function jobInput(overrides: { sessionId?: string; messageId?: string } = {}) {
  return {
    source: "automation" as const,
    sessionId: overrides.sessionId ?? "session-1",
    messageId: overrides.messageId ?? "message-1",
    success: true,
    channel: "C123",
    threadTs: "111.222",
    context,
  };
}

describe("slackCompletionDeliveryId", () => {
  it("derives the same id for the same completion", () => {
    expect(slackCompletionDeliveryId("session-1", "message-1")).toBe(
      slackCompletionDeliveryId("session-1", "message-1")
    );
    expect(createSlackCompletionJob(jobInput()).deliveryId).toBe("completion:session-1:message-1");
  });

  it("keeps completions apart when an id contains the separator", () => {
    expect(slackCompletionDeliveryId("a:b", "c")).not.toBe(slackCompletionDeliveryId("a", "b:c"));
  });

  it("changes when the message changes", () => {
    expect(slackCompletionDeliveryId("session-1", "message-1")).not.toBe(
      slackCompletionDeliveryId("session-1", "message-2")
    );
  });
});

describe("slackCompletionJobSchema", () => {
  it("accepts the derived delivery id", () => {
    const derived = createSlackCompletionJob(jobInput());
    expect(slackCompletionJobSchema.parse(derived)).toMatchObject({
      deliveryId: "completion:session-1:message-1",
    });
  });

  it("accepts any non-empty delivery id and rejects an empty one", () => {
    const derived = createSlackCompletionJob(jobInput());
    expect(
      slackCompletionJobSchema.safeParse({
        ...derived,
        deliveryId: "11111111-1111-4111-8111-111111111111",
      }).success
    ).toBe(true);
    expect(
      slackCompletionJobSchema.safeParse({ ...derived, deliveryId: "not-a-delivery" }).success
    ).toBe(true);
    expect(slackCompletionJobSchema.safeParse({ ...derived, deliveryId: "" }).success).toBe(false);
  });
});
