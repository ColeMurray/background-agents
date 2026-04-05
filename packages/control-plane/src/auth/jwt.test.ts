import { describe, it, expect } from "vitest";
import { mintJwt } from "./jwt";

describe("mintJwt", () => {
  it("produces a valid 3-part base64url JWT", async () => {
    const token = await mintJwt({ sub: "test", iat: 1000 }, "secret");
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    // Each part should be valid base64url (no +, /, or =)
    for (const part of parts) {
      expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("encodes the correct header", async () => {
    const token = await mintJwt({ sub: "test" }, "secret");
    const [headerB64] = token.split(".");
    const header = JSON.parse(atob(headerB64.replace(/-/g, "+").replace(/_/g, "/")));
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });
  });

  it("encodes the payload correctly", async () => {
    const payload = { sub: "sess-1", sid: "sb-1", iat: 1000, exp: 2000 };
    const token = await mintJwt(payload, "secret");
    const [, bodyB64] = token.split(".");
    const body = JSON.parse(atob(bodyB64.replace(/-/g, "+").replace(/_/g, "/")));
    expect(body).toEqual(payload);
  });

  it("produces verifiable HS256 signature", async () => {
    const secret = "test-secret-key";
    const token = await mintJwt({ sub: "test" }, secret);
    const [header, payload, sig] = token.split(".");

    // Verify with Web Crypto
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const sigBytes = Uint8Array.from(
      atob(sig.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (sig.length % 4)) % 4)),
      (c) => c.charCodeAt(0)
    );
    const data = new TextEncoder().encode(`${header}.${payload}`);
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, data);
    expect(valid).toBe(true);
  });

  it("produces different tokens for different secrets", async () => {
    const payload = { sub: "test" };
    const token1 = await mintJwt(payload, "secret-1");
    const token2 = await mintJwt(payload, "secret-2");
    expect(token1).not.toBe(token2);
  });
});
