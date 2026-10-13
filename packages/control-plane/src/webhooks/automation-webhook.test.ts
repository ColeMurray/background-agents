import { describe, expect, it } from "vitest";
import { WEBHOOK_SESSION_KEY_MAX_LENGTH } from "@open-inspect/shared/triggers";
import { parseWebhookDeliveryFields } from "./automation-webhook";

describe("parseWebhookDeliveryFields", () => {
  it("reads both delivery fields", () => {
    expect(
      parseWebhookDeliveryFields({ idempotencyKey: "deploy-123", sessionKey: "card-42" })
    ).toEqual({
      ok: true,
      fields: { idempotencyKey: "deploy-123", sessionKey: "card-42" },
    });
  });

  it("leaves both unset for a body without them or a body that is not an object", () => {
    expect(parseWebhookDeliveryFields({ action: "deploy" })).toEqual({ ok: true, fields: {} });
    expect(parseWebhookDeliveryFields(null)).toEqual({ ok: true, fields: {} });
    expect(parseWebhookDeliveryFields(["sessionKey"])).toEqual({ ok: true, fields: {} });
  });

  it("ignores an idempotencyKey that is not a string", () => {
    expect(parseWebhookDeliveryFields({ idempotencyKey: 123 })).toEqual({ ok: true, fields: {} });
    expect(parseWebhookDeliveryFields({ idempotencyKey: null })).toEqual({ ok: true, fields: {} });
  });

  it.each(["", 42, null, "k".repeat(WEBHOOK_SESSION_KEY_MAX_LENGTH + 1)])(
    "rejects a sessionKey of %j",
    (sessionKey) => {
      expect(parseWebhookDeliveryFields({ sessionKey })).toEqual({
        ok: false,
        error: `sessionKey must be a non-empty string of at most ${WEBHOOK_SESSION_KEY_MAX_LENGTH} characters`,
      });
    }
  );

  it("accepts a sessionKey at the length limit", () => {
    const sessionKey = "k".repeat(WEBHOOK_SESSION_KEY_MAX_LENGTH);
    expect(parseWebhookDeliveryFields({ sessionKey })).toEqual({
      ok: true,
      fields: { sessionKey },
    });
  });
});
