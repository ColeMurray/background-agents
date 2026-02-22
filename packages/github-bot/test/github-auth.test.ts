import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateAppJwt, postReaction, checkSenderPermission } from "../src/github-auth";

/** Generate a PKCS#8 PEM RSA key pair for testing. */
async function generateTestKeyPair(): Promise<{ privateKeyPem: string }> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );

  const exported = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
  const lines = base64.match(/.{1,64}/g)!.join("\n");
  return { privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----` };
}

describe("generateAppJwt", () => {
  it("produces a valid 3-part JWT", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const jwt = await generateAppJwt("12345", privateKeyPem);

    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    // Decode header
    const header = JSON.parse(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")));
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });

    // Decode payload
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    expect(payload.iss).toBe("12345");
    expect(payload.iat).toBeTypeOf("number");
    expect(payload.exp).toBeTypeOf("number");
    expect(payload.exp - payload.iat).toBe(660); // 600 + 60 clock skew
  });

  it("JWT claims have correct time ranges", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const now = Math.floor(Date.now() / 1000);
    const jwt = await generateAppJwt("99", privateKeyPem);

    const payload = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    expect(payload.iat).toBeGreaterThanOrEqual(now - 62);
    expect(payload.iat).toBeLessThanOrEqual(now - 58);
    expect(payload.exp).toBeGreaterThanOrEqual(now + 598);
    expect(payload.exp).toBeLessThanOrEqual(now + 602);
  });
});

describe("postReaction", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls fetch with correct parameters", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("", { status: 201 }));

    const url = "https://api.github.com/repos/acme/widgets/issues/42/reactions";
    await postReaction("test-token", url, "eyes");

    expect(globalThis.fetch).toHaveBeenCalledWith(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Open-Inspect",
      },
      body: JSON.stringify({ content: "eyes" }),
    });
  });

  it("returns true on success (201)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("", { status: 201 }));
    const result = await postReaction("tok", "https://api.github.com/test", "eyes");
    expect(result).toBe(true);
  });

  it("returns true on 200", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("", { status: 200 }));
    const result = await postReaction("tok", "https://api.github.com/test", "eyes");
    expect(result).toBe(true);
  });

  it("returns false on 403", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("Forbidden", { status: 403 }));
    const result = await postReaction("tok", "https://api.github.com/test", "eyes");
    expect(result).toBe(false);
  });

  it("returns false on network error", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("network error"));
    const result = await postReaction("tok", "https://api.github.com/test", "eyes");
    expect(result).toBe(false);
  });
});

describe("checkSenderPermission", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns true for write permission", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ permission: "write" }), { status: 200 })
    );
    expect(await checkSenderPermission("tok", "acme", "widgets", "alice")).toBe(true);
  });

  it("returns true for admin permission", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ permission: "admin" }), { status: 200 })
    );
    expect(await checkSenderPermission("tok", "acme", "widgets", "alice")).toBe(true);
  });

  it("returns true for maintain permission", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ permission: "maintain" }), { status: 200 })
    );
    expect(await checkSenderPermission("tok", "acme", "widgets", "alice")).toBe(true);
  });

  it("returns false for read permission", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ permission: "read" }), { status: 200 })
    );
    expect(await checkSenderPermission("tok", "acme", "widgets", "alice")).toBe(false);
  });

  it("returns false for none permission", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ permission: "none" }), { status: 200 })
    );
    expect(await checkSenderPermission("tok", "acme", "widgets", "alice")).toBe(false);
  });

  it("returns false on API error (404)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("Not Found", { status: 404 }));
    expect(await checkSenderPermission("tok", "acme", "widgets", "alice")).toBe(false);
  });

  it("returns false on network error", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("network error"));
    expect(await checkSenderPermission("tok", "acme", "widgets", "alice")).toBe(false);
  });

  it("calls correct GitHub API URL", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ permission: "write" }), { status: 200 })
    );
    await checkSenderPermission("test-token", "acme", "widgets", "alice");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/widgets/collaborators/alice/permission",
      {
        headers: {
          Authorization: "Bearer test-token",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Open-Inspect",
        },
      }
    );
  });
});
