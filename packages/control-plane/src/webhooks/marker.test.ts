import { computeHmacHex } from "@open-inspect/shared/auth";
import { describe, expect, it } from "vitest";
import { parseMarkerIdempotencyKey, verifyMarkerSignature } from "./marker";

describe("verifyMarkerSignature", () => {
  it("accepts only the Marker sha256 signature for the raw body", async () => {
    const body = JSON.stringify({ type: "issue.created", data: { id: "issue-1" } });
    const secret = "marker-secret";
    const signature = `sha256=${await computeHmacHex(body, secret)}`;

    await expect(verifyMarkerSignature(body, signature, secret)).resolves.toBe(true);
    await expect(verifyMarkerSignature(`${body}\n`, signature, secret)).resolves.toBe(false);
    await expect(verifyMarkerSignature(body, signature, "wrong-secret")).resolves.toBe(false);
    await expect(verifyMarkerSignature(body, signature.slice(7), secret)).resolves.toBe(false);
    await expect(verifyMarkerSignature(body, "sha256=invalid", secret)).resolves.toBe(false);
    await expect(verifyMarkerSignature(body, null, secret)).resolves.toBe(false);
  });
});

describe("parseMarkerIdempotencyKey", () => {
  it("deduplicates resource events by type and resource id", () => {
    expect(
      parseMarkerIdempotencyKey({
        type: "issue.created",
        webhookId: "webhook-1",
        webhookTimestamp: 1751876876200,
        data: { id: "issue-1" },
      })
    ).toBe("marker:issue.created:issue-1:1751876876200");
  });

  it("falls back to the webhook delivery identity", () => {
    expect(
      parseMarkerIdempotencyKey({
        webhookId: "webhook-1",
        webhookTimestamp: 1751876876200,
      })
    ).toBe("marker:webhook-1:1751876876200");
  });

  it("returns undefined without a stable Marker identity", () => {
    expect(parseMarkerIdempotencyKey({ type: "issue.created", data: {} })).toBeUndefined();
    expect(parseMarkerIdempotencyKey(null)).toBeUndefined();
  });
});
