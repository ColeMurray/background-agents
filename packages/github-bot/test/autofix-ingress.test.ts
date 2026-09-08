import { describe, expect, it } from "vitest";
import { toAutofixEnvelope } from "../src/autofix-ingress";

function issueCommentPayload(body: string) {
  return {
    action: "created",
    issue: {
      number: 42,
      pull_request: {},
    },
    comment: {
      id: 1234,
      body,
    },
    repository: {
      id: 99,
      name: "widgets",
      owner: { login: "acme" },
    },
  };
}

function envelopeFor(body: string, botUsername: string | undefined) {
  return toAutofixEnvelope({
    event: "issue_comment",
    payload: issueCommentPayload(body),
    deliveryId: "delivery-1",
    botUsername,
    receivedAt: new Date("2026-07-30T05:00:00.000Z"),
  });
}

describe("toAutofixEnvelope", () => {
  it("remains safe when the bot username binding is absent at runtime", () => {
    expect(envelopeFor("Please address this.", undefined)).toMatchObject({
      eventType: "issue_comment",
      providerObject: { kind: "pr_comment", id: "1234" },
    });
  });

  it("suppresses an exact bot mention case-insensitively", () => {
    expect(envelopeFor("Please investigate, @TEST-BOT[BOT].", "test-bot[bot]")).toBeNull();
  });

  it("does not treat a longer username prefix as the configured bot mention", () => {
    expect(envelopeFor("Please ask @test-bot[bot]-clone.", "test-bot[bot]")).not.toBeNull();
  });
});
