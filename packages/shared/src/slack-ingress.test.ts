import { describe, expect, it } from "vitest";
import {
  slackIngressAdmitSchema,
  slackIngressClaimSchema,
  slackIngressTransitionSchema,
} from "./slack-ingress";

describe("Slack ingress contracts", () => {
  it("requires one bounded payload source and rejects unknown or secret-shaped fields", () => {
    const base = {
      source: "slack",
      externalEventId: "Ev1",
      payloadSha256: "a".repeat(64),
      channelId: "C1",
      stableSessionId: "s1",
      stableMessageId: "m1",
      deadlineAt: 1,
    };
    expect(slackIngressAdmitSchema.safeParse({ ...base, payloadJson: "{}" }).success).toBe(true);
    expect(
      slackIngressAdmitSchema.safeParse({ ...base, payloadJson: "{}", payloadRef: "r" }).success
    ).toBe(false);
    expect(
      slackIngressAdmitSchema.safeParse({ ...base, payloadJson: "{}", token: "secret" }).success
    ).toBe(false);
  });
  it("bounds leases and transition errors", () => {
    expect(slackIngressClaimSchema.safeParse({ leaseOwner: "w", leaseMs: 999 }).success).toBe(
      false
    );
    expect(
      slackIngressTransitionSchema.safeParse({
        leaseOwner: "w",
        expectedState: "processing",
        state: "failed",
        errorCode: "x".repeat(129),
      }).success
    ).toBe(false);
  });
});
