import { describe, expect, it } from "vitest";
import { WEBHOOK_SESSION_KEY_MAX_LENGTH } from "@open-inspect/shared/triggers";
import { followUpRefusedResponse, parseWebhookDeliveryFields } from "./automation-webhook";
import { SessionFollowUpRefusedError } from "../scheduler/contracts";

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

describe("followUpRefusedResponse", () => {
  it.each([
    { status: 409, code: "BUDGET_EXHAUSTED", expected: 409, expectedCode: "BUDGET_EXHAUSTED" },
    { status: 429, code: "PROMPT_QUEUE_FULL", expected: 429, expectedCode: "PROMPT_QUEUE_FULL" },
    { status: null, code: null, expected: 503, expectedCode: "SESSION_UNAVAILABLE" },
    { status: 500, code: null, expected: 503, expectedCode: "SESSION_UNAVAILABLE" },
    {
      status: 400,
      code: "HARNESS_MODEL_INCOMPATIBLE",
      expected: 422,
      expectedCode: "HARNESS_MODEL_INCOMPATIBLE",
    },
    { status: 400, code: null, expected: 422, expectedCode: "FOLLOW_UP_REJECTED" },
  ])(
    "answers a $status refusal with $expected",
    async ({ status, code, expected, expectedCode }) => {
      const response = followUpRefusedResponse(
        new SessionFollowUpRefusedError({ kind: "refused", invocationId: "inv-1", status, code })
      );

      expect(response.status).toBe(expected);
      expect(await response.json()).toMatchObject({ code: expectedCode, invocationId: "inv-1" });
    }
  );
});
