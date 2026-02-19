import { describe, it, expect } from "vitest";
import { verifyWebhookSignature } from "../src/verify";

/** Generate a valid GitHub webhook signature for a given secret and body. */
async function sign(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

describe("verifyWebhookSignature", () => {
  const secret = "test-webhook-secret";

  it("accepts a valid signature", async () => {
    const body = '{"action":"created"}';
    const signature = await sign(secret, body);
    expect(await verifyWebhookSignature(secret, body, signature)).toBe(true);
  });

  it("rejects an invalid signature", async () => {
    const body = '{"action":"created"}';
    const signature = "sha256=0000000000000000000000000000000000000000000000000000000000000000";
    expect(await verifyWebhookSignature(secret, body, signature)).toBe(false);
  });

  it("rejects a null signature header", async () => {
    expect(await verifyWebhookSignature(secret, "body", null)).toBe(false);
  });

  it("rejects a wrong prefix", async () => {
    const body = '{"action":"created"}';
    const signature = await sign(secret, body);
    const sha1Signature = signature.replace("sha256=", "sha1=");
    expect(await verifyWebhookSignature(secret, body, sha1Signature)).toBe(false);
  });

  it("rejects a tampered payload", async () => {
    const body = '{"action":"created"}';
    const signature = await sign(secret, body);
    const tampered = '{"action":"deleted"}';
    expect(await verifyWebhookSignature(secret, tampered, signature)).toBe(false);
  });

  it("accepts an empty body with valid signature", async () => {
    const body = "";
    const signature = await sign(secret, body);
    expect(await verifyWebhookSignature(secret, body, signature)).toBe(true);
  });

  it("rejects an empty signature header", async () => {
    expect(await verifyWebhookSignature(secret, "body", "")).toBe(false);
  });

  it("rejects signature with correct prefix but wrong hash", async () => {
    const body = '{"action":"created"}';
    const wrongSecret = "wrong-secret";
    const signature = await sign(wrongSecret, body);
    expect(await verifyWebhookSignature(secret, body, signature)).toBe(false);
  });
});
