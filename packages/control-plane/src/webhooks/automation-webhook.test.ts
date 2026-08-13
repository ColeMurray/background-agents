import { describe, expect, it } from "vitest";
import { parseWebhookIdempotencyKey } from "./automation-webhook";

describe("parseWebhookIdempotencyKey", () => {
  it("returns a string idempotency key", () => {
    expect(parseWebhookIdempotencyKey({ idempotencyKey: "deploy-123" })).toBe("deploy-123");
  });

  it("returns undefined when the key is missing", () => {
    expect(parseWebhookIdempotencyKey({ action: "deploy" })).toBeUndefined();
  });

  it("rejects malformed idempotency keys", () => {
    expect(parseWebhookIdempotencyKey({ idempotencyKey: 123 })).toBeUndefined();
    expect(parseWebhookIdempotencyKey({ idempotencyKey: null })).toBeUndefined();
    expect(parseWebhookIdempotencyKey(null)).toBeUndefined();
  });
});
