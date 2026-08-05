import { describe, expect, it } from "vitest";
import { githubAutofixEnvelopeSchema } from "./github-autofix";

const reviewEnvelope = {
  version: 1,
  eventType: "pull_request_review",
  action: "submitted",
  deliveryId: "delivery-1",
  traceId: "trace-1",
  providerObject: { kind: "review", id: "5678" },
  repository: { id: "99", owner: "acme", name: "widgets" },
  pullRequestNumber: 42,
  receivedAt: "2026-07-30T05:00:00.000Z",
} as const;

describe("githubAutofixEnvelopeSchema", () => {
  it("preserves trace provenance for a submitted review", () => {
    expect(githubAutofixEnvelopeSchema.parse(reviewEnvelope)).toEqual(reviewEnvelope);
  });

  it("rejects a submitted review without trace provenance", () => {
    const { traceId: _traceId, ...missingTrace } = reviewEnvelope;

    expect(githubAutofixEnvelopeSchema.safeParse(missingTrace).success).toBe(false);
  });
});
