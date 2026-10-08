import { describe, expect, it } from "vitest";
import { parseWebhookIdempotencyKey, parseWebhookSessionKey } from "./automation-webhook";

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

describe("parseWebhookSessionKey", () => {
  it("returns a string session key", () => {
    expect(parseWebhookSessionKey({ sessionKey: "card-42" })).toEqual({
      ok: true,
      sessionKey: "card-42",
    });
  });

  it("leaves the session key unset when it is missing", () => {
    expect(parseWebhookSessionKey({ action: "deploy" })).toEqual({
      ok: true,
      sessionKey: undefined,
    });
    expect(parseWebhookSessionKey(null)).toEqual({ ok: true, sessionKey: undefined });
  });

  it("refuses a session key that is not a non-empty string", () => {
    expect(parseWebhookSessionKey({ sessionKey: "" })).toEqual({ ok: false });
    expect(parseWebhookSessionKey({ sessionKey: 42 })).toEqual({ ok: false });
    expect(parseWebhookSessionKey({ sessionKey: null })).toEqual({ ok: false });
  });
});
