import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  generateAppJwt,
  generateInstallationToken,
  postReaction,
  postCommitStatus,
  checkSenderPermission,
  getPullRequestApproval,
  GITHUB_API_REQUEST_TIMEOUT_MS,
} from "../src/github-auth";

function stalledFetch() {
  return vi.mocked(globalThis.fetch).mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })
  );
}

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
    vi.restoreAllMocks();
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
      signal: expect.any(AbortSignal),
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

  it("uses the configured User-Agent when one is provided", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("", { status: 201 }));
    await postReaction("tok", "https://api.github.com/test", "eyes", "Acme Bot");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.github.com/test",
      expect.objectContaining({
        headers: expect.objectContaining({ "User-Agent": "Acme Bot" }),
      })
    );
  });

  it("defaults the User-Agent to Open-Inspect when omitted", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("", { status: 201 }));
    await postReaction("tok", "https://api.github.com/test", "eyes");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.github.com/test",
      expect.objectContaining({
        headers: expect.objectContaining({ "User-Agent": "Open-Inspect" }),
      })
    );
  });

  it("returns false when a stalled reaction reaches its deadline", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    stalledFetch();

    const resultPromise = postReaction("tok", "https://api.github.com/test", "eyes");
    timeout.abort(new DOMException("deadline exceeded", "TimeoutError"));

    await expect(resultPromise).resolves.toBe(false);
    expect(timeoutSpy).toHaveBeenCalledWith(GITHUB_API_REQUEST_TIMEOUT_MS);
  });
});

describe("postCommitStatus", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts the status to the exact commit SHA", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("", { status: 201 }));

    const result = await postCommitStatus(
      "test-token",
      "acme",
      "widgets",
      "abc123",
      {
        state: "pending",
        context: "open-inspect",
        description: "Review in progress",
      },
      "Acme Bot"
    );

    expect(result).toEqual({ ok: true });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/widgets/statuses/abc123",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Acme Bot",
        },
        body: JSON.stringify({
          state: "pending",
          context: "open-inspect",
          description: "Review in progress",
        }),
      }
    );
  });

  it("includes a review target URL when completing the status", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("", { status: 201 }));
    const targetUrl = "https://github.com/acme/widgets/pull/42#pullrequestreview-100";

    await postCommitStatus("test-token", "acme", "widgets", "abc123", {
      state: "success",
      context: "open-inspect",
      description: "Review completed",
      targetUrl,
    });

    const [, request] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(JSON.parse(request?.body as string)).toEqual({
      state: "success",
      context: "open-inspect",
      description: "Review completed",
      target_url: targetUrl,
    });
  });

  it("returns GitHub's status code when the status is rejected", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("Forbidden", { status: 403 }));

    const result = await postCommitStatus("test-token", "acme", "widgets", "abc123", {
      state: "pending",
      context: "open-inspect",
      description: "Review in progress",
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "GitHub API returned 403",
    });
  });

  it("returns the network error when the request fails", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("connection reset"));

    const result = await postCommitStatus("test-token", "acme", "widgets", "abc123", {
      state: "pending",
      context: "open-inspect",
      description: "Review in progress",
    });

    expect(result).toEqual({
      ok: false,
      error: "connection reset",
    });
  });
});

describe("generateInstallationToken", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns the token from a valid GitHub response", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ token: "installation-token" }), { status: 201 })
    );

    await expect(
      generateInstallationToken({
        appId: "12345",
        privateKey: privateKeyPem,
        installationId: "67890",
      })
    ).resolves.toBe("installation-token");
  });

  it("rejects a malformed GitHub token response", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: "not-a-token" }), { status: 201 })
    );

    await expect(
      generateInstallationToken({
        appId: "12345",
        privateKey: privateKeyPem,
        installationId: "67890",
      })
    ).rejects.toThrow("Failed to get installation token: invalid response");
  });

  it("rejects an invalid JSON GitHub token response", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("not json", { status: 201 }));

    await expect(
      generateInstallationToken({
        appId: "12345",
        privateKey: privateKeyPem,
        installationId: "67890",
      })
    ).rejects.toThrow("Failed to get installation token: invalid response");
  });

  it("rejects when a stalled installation-token request reaches its deadline", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    stalledFetch();

    const tokenPromise = generateInstallationToken({
      appId: "12345",
      privateKey: privateKeyPem,
      installationId: "67890",
    });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    timeout.abort(new DOMException("deadline exceeded", "TimeoutError"));

    await expect(tokenPromise).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeoutSpy).toHaveBeenCalledWith(GITHUB_API_REQUEST_TIMEOUT_MS);
  });
});

describe("checkSenderPermission", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns hasPermission true for write permission", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ permission: "write" }), { status: 200 })
    );
    const result = await checkSenderPermission("tok", "acme", "widgets", "alice");
    expect(result).toEqual({ hasPermission: true });
  });

  it("returns hasPermission true for admin permission", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ permission: "admin" }), { status: 200 })
    );
    const result = await checkSenderPermission("tok", "acme", "widgets", "alice");
    expect(result).toEqual({ hasPermission: true });
  });

  it("returns hasPermission true for maintain permission", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ permission: "maintain" }), { status: 200 })
    );
    const result = await checkSenderPermission("tok", "acme", "widgets", "alice");
    expect(result).toEqual({ hasPermission: true });
  });

  it("returns hasPermission false for read permission", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ permission: "read" }), { status: 200 })
    );
    const result = await checkSenderPermission("tok", "acme", "widgets", "alice");
    expect(result).toEqual({ hasPermission: false });
  });

  it("returns hasPermission false for none permission", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ permission: "none" }), { status: 200 })
    );
    const result = await checkSenderPermission("tok", "acme", "widgets", "alice");
    expect(result).toEqual({ hasPermission: false });
  });

  it("returns error flag on malformed permission response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ user: { login: "alice" } }), { status: 200 })
    );
    const result = await checkSenderPermission("tok", "acme", "widgets", "alice");
    expect(result).toEqual({ hasPermission: false, error: true });
  });

  it("returns error flag on API error (404)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("Not Found", { status: 404 }));
    const result = await checkSenderPermission("tok", "acme", "widgets", "alice");
    expect(result).toEqual({ hasPermission: false, error: true });
  });

  it("returns error flag on network error", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("network error"));
    const result = await checkSenderPermission("tok", "acme", "widgets", "alice");
    expect(result).toEqual({ hasPermission: false, error: true });
  });

  it("calls correct GitHub API URL with encoded segments", async () => {
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
        signal: expect.any(AbortSignal),
      }
    );
  });

  it("uses the configured User-Agent when one is provided", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ permission: "write" }), { status: 200 })
    );
    await checkSenderPermission("tok", "acme", "widgets", "alice", "Acme Bot");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ "User-Agent": "Acme Bot" }),
      })
    );
  });

  it("fails closed when a stalled permission check reaches its deadline", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    stalledFetch();

    const resultPromise = checkSenderPermission("tok", "acme", "widgets", "alice");
    timeout.abort(new DOMException("deadline exceeded", "TimeoutError"));

    await expect(resultPromise).resolves.toEqual({ hasPermission: false, error: true });
    expect(timeoutSpy).toHaveBeenCalledWith(GITHUB_API_REQUEST_TIMEOUT_MS);
  });
});

describe("getPullRequestApproval", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function reviewsResponse(reviews: { login: string | null; state: string }[]): Response {
    return new Response(
      JSON.stringify(
        reviews.map((r) => ({ user: r.login ? { login: r.login } : null, state: r.state }))
      ),
      { status: 200 }
    );
  }

  it("reports an approval from a reviewer who has not changed their verdict", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      reviewsResponse([{ login: "alice", state: "APPROVED" }])
    );
    await expect(getPullRequestApproval("tok", "acme", "widgets", 42)).resolves.toEqual({
      ok: true,
      approved: true,
    });
  });

  it("reports no approval for a PR nobody has reviewed", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(reviewsResponse([]));
    await expect(getPullRequestApproval("tok", "acme", "widgets", 42)).resolves.toEqual({
      ok: true,
      approved: false,
    });
  });

  it("lets a reviewer's later CHANGES_REQUESTED override their own earlier approval", async () => {
    // GitHub keeps every review ever submitted, so an APPROVED row existing is not the same as
    // the PR being approved.
    vi.mocked(globalThis.fetch).mockResolvedValue(
      reviewsResponse([
        { login: "alice", state: "APPROVED" },
        { login: "alice", state: "CHANGES_REQUESTED" },
      ])
    );
    await expect(getPullRequestApproval("tok", "acme", "widgets", 42)).resolves.toEqual({
      ok: true,
      approved: false,
    });
  });

  it("does not let a COMMENTED review clear an earlier approval", async () => {
    // GitHub itself treats a comment as leaving the approval standing.
    vi.mocked(globalThis.fetch).mockResolvedValue(
      reviewsResponse([
        { login: "alice", state: "APPROVED" },
        { login: "alice", state: "COMMENTED" },
      ])
    );
    await expect(getPullRequestApproval("tok", "acme", "widgets", 42)).resolves.toEqual({
      ok: true,
      approved: true,
    });
  });

  it("treats a dismissed approval as withdrawn", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      reviewsResponse([{ login: "alice", state: "DISMISSED" }])
    );
    await expect(getPullRequestApproval("tok", "acme", "widgets", 42)).resolves.toEqual({
      ok: true,
      approved: false,
    });
  });

  it("still reports an approval when another reviewer requested changes", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      reviewsResponse([
        { login: "alice", state: "APPROVED" },
        { login: "bob", state: "CHANGES_REQUESTED" },
      ])
    );
    await expect(getPullRequestApproval("tok", "acme", "widgets", 42)).resolves.toEqual({
      ok: true,
      approved: true,
    });
  });

  it("ignores a review whose author no longer exists", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      reviewsResponse([{ login: null, state: "APPROVED" }])
    );
    await expect(getPullRequestApproval("tok", "acme", "widgets", 42)).resolves.toEqual({
      ok: true,
      approved: false,
    });
  });

  it("walks past the first page so a late verdict is not missed", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      login: `user${i}`,
      state: "COMMENTED",
    }));
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(reviewsResponse(firstPage))
      .mockResolvedValueOnce(reviewsResponse([{ login: "alice", state: "APPROVED" }]));

    await expect(getPullRequestApproval("tok", "acme", "widgets", 42)).resolves.toEqual({
      ok: true,
      approved: true,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(globalThis.fetch).mock.calls[1]?.[0]).toContain("page=2");
  });

  it("stops after a short page rather than paging forever", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      reviewsResponse([{ login: "alice", state: "APPROVED" }])
    );
    await getPullRequestApproval("tok", "acme", "widgets", 42);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("reports failure rather than a verdict when the API errors", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("Bad Gateway", { status: 502 }));
    await expect(getPullRequestApproval("tok", "acme", "widgets", 42)).resolves.toEqual({
      ok: false,
      error: "GitHub API returned 502",
    });
  });

  it("reports failure on a malformed response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ reviews: [] }), { status: 200 })
    );
    await expect(getPullRequestApproval("tok", "acme", "widgets", 42)).resolves.toEqual({
      ok: false,
      error: "invalid response",
    });
  });

  it("reports failure on a network error", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("network error"));
    await expect(getPullRequestApproval("tok", "acme", "widgets", 42)).resolves.toEqual({
      ok: false,
      error: "network error",
    });
  });

  it("reports failure when a stalled lookup reaches its deadline", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    stalledFetch();

    const resultPromise = getPullRequestApproval("tok", "acme", "widgets", 42);
    timeout.abort(new DOMException("deadline exceeded", "TimeoutError"));

    await expect(resultPromise).resolves.toMatchObject({ ok: false });
    expect(timeoutSpy).toHaveBeenCalledWith(GITHUB_API_REQUEST_TIMEOUT_MS);
  });
});
