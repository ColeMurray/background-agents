import { describe, it, expect } from "vitest";
import { generateWebhookApiKey, hashApiKey, verifyWebhookApiKey } from "./webhook-key";

describe("webhook-key", () => {
  it("generates a base64url-encoded key", () => {
    const key = generateWebhookApiKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(key.length).toBeGreaterThan(20);
  });

  it("generates unique keys", () => {
    const key1 = generateWebhookApiKey();
    const key2 = generateWebhookApiKey();
    expect(key1).not.toBe(key2);
  });

  it("hashApiKey produces a hex string", async () => {
    const key = generateWebhookApiKey();
    const hash = await hashApiKey(key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifyWebhookApiKey returns true for matching key", async () => {
    const key = generateWebhookApiKey();
    const hash = await hashApiKey(key);
    expect(await verifyWebhookApiKey(key, hash)).toBe(true);
  });

  it("verifyWebhookApiKey returns false for wrong key", async () => {
    const key = generateWebhookApiKey();
    const hash = await hashApiKey(key);
    const wrongKey = generateWebhookApiKey();
    expect(await verifyWebhookApiKey(wrongKey, hash)).toBe(false);
  });
});
