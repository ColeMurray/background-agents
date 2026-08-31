import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./api-client.js";
import { CliError, exitCodeFor } from "./errors.js";

const credential = `oi_cli_${"a".repeat(64)}`;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe("ApiClient", () => {
  it("uses public device auth endpoints without persisting or authorizing the device secret", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json(
          {
            deviceSecret: "a".repeat(64),
            userCode: "ABCD-EFGH",
            verificationUrl: "https://web.example.com/cli/authorize",
            expiresAt: Date.now() + 60_000,
            pollIntervalMs: 1,
          },
          201
        )
      )
      .mockResolvedValueOnce(json({ status: "pending", expiresAt: Date.now() + 60_000 }, 202))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new ApiClient({ baseUrl: "https://api.example.com/", fetch });

    const started = await client.startDeviceAuthorization("test host");
    await client.exchangeDeviceAuthorization(started.deviceSecret);
    await client.revokeDeviceAuthorization(started.deviceSecret);

    expect(fetch.mock.calls.map(([request]) => new URL(String(request)).pathname)).toEqual([
      "/external/v1/cli/device-authorizations",
      "/external/v1/cli/device-authorizations/exchange",
      "/external/v1/cli/device-authorizations/revoke",
    ]);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).has("Authorization")).toBe(false);
    expect(new Headers(fetch.mock.calls[2]?.[1]?.headers).has("Authorization")).toBe(false);
  });

  it("reauthorizes every request and preserves caller-supplied request IDs", async () => {
    const credentials = [credential, credential.replace("a", "b")];
    const authorize = vi.fn(() => Promise.resolve(credentials.shift()));
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ sessions: [], hasMore: false }))
      .mockResolvedValueOnce(json({ messageId: "message-1", status: "queued" }));
    const client = new ApiClient({
      baseUrl: "https://api.example.com",
      authorize,
      fetch,
    });

    await client.listSessions();
    await client.promptSession("session/with slash", {
      content: "Continue",
      clientRequestId: "caller-request",
    });

    expect(authorize).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      `Bearer ${credential}`
    );
    expect(new URL(String(fetch.mock.calls[1]?.[0])).pathname).toBe(
      "/external/v1/sessions/session%2Fwith%20slash/messages"
    );
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      clientRequestId: "caller-request",
    });
  });

  it("encodes checkpoint, cursor, and limit event query options", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() =>
        Promise.resolve(json({ changes: [], checkpoint: 12, cursor: "next page", hasMore: true }))
      );
    const client = new ApiClient({
      baseUrl: "https://api.example.com",
      authorize: () => Promise.resolve(credential),
      fetch,
    });

    await client.events("s1", { after: 10, limit: 200 });
    await client.events("s1", { cursor: "next page" });

    expect(new URL(String(fetch.mock.calls[0]?.[0])).search).toBe("?after=10&limit=200");
    expect(new URL(String(fetch.mock.calls[1]?.[0])).searchParams.get("cursor")).toBe("next page");
    await expect(client.events("s1", { after: 1, cursor: "invalid" })).rejects.toMatchObject({
      name: "ZodError",
    });
  });

  it("validates and encodes bounded session list pagination", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ sessions: [], hasMore: true, continuationOffset: 125 }));
    const client = new ApiClient({
      baseUrl: "https://api.example.com",
      authorize: () => Promise.resolve(credential),
      fetch,
    });

    await expect(client.listSessions({ limit: 25, offset: 100 })).resolves.toEqual({
      sessions: [],
      hasMore: true,
      continuationOffset: 125,
    });
    expect(new URL(String(fetch.mock.calls[0]?.[0])).search).toBe("?limit=25&offset=100");
    await expect(client.listSessions({ limit: 201 })).rejects.toMatchObject({ name: "ZodError" });
  });

  it.each([
    [401, "auth", 2],
    [400, "validation", 3],
    [409, "conflict", 4],
    [408, "timeout", 5],
    [404, "not_found", 8],
    [410, "expired", 9],
    [429, "rate_limited", 10],
    [503, "service", 7],
  ] as const)("classifies HTTP %s responses as %s errors", async (status, kind, exitCode) => {
    const client = new ApiClient({
      baseUrl: "https://api.example.com",
      authorize: () => Promise.resolve(credential),
      fetch: vi.fn().mockResolvedValue(json({ error: "request failed" }, status)),
    });
    const error = await client.listSessions().catch((cause) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, kind });
    expect(exitCodeFor(error)).toBe(exitCode);
  });

  it("never exposes an arbitrary HTML error body", async () => {
    const client = new ApiClient({
      baseUrl: "https://api.example.com",
      authorize: () => Promise.resolve(credential),
      fetch: vi.fn().mockResolvedValue(
        new Response("<html><script>secret()</script></html>", {
          status: 502,
          statusText: "Bad Gateway",
        })
      ),
    });
    const error = await client.listSessions().catch((cause) => cause);
    expect(error.message).toContain("Bad Gateway");
    expect(error.message).not.toContain("html");
  });

  it("distinguishes missing auth, timeout, transport, invalid JSON, and oversized responses", async () => {
    const unauthenticated = new ApiClient({ baseUrl: "https://api.example.com", fetch: vi.fn() });
    await expect(unauthenticated.listSessions()).rejects.toMatchObject({ kind: "auth" });

    const controller = new AbortController();
    controller.abort();
    const timedOut = new ApiClient({
      baseUrl: "https://api.example.com",
      authorize: () => Promise.resolve(credential),
      fetch: vi.fn().mockRejectedValue(new Error("aborted")),
    });
    await expect(timedOut.listSessions({ signal: controller.signal })).rejects.toMatchObject({
      kind: "timeout",
    });

    const transport = new ApiClient({
      baseUrl: "https://api.example.com",
      authorize: () => Promise.resolve(credential),
      fetch: vi.fn().mockRejectedValue(new TypeError("network down")),
    });
    await expect(transport.listSessions()).rejects.toMatchObject({ kind: "transport" });

    const invalid = new ApiClient({
      baseUrl: "https://api.example.com",
      authorize: () => Promise.resolve(credential),
      fetch: vi.fn().mockResolvedValue(new Response("not json")),
    });
    await expect(invalid.listSessions()).rejects.toBeInstanceOf(CliError);

    const oversized = new ApiClient({
      baseUrl: "https://api.example.com",
      authorize: () => Promise.resolve(credential),
      fetch: vi.fn().mockResolvedValue(new Response("x".repeat(5 * 1024 * 1024 + 1))),
    });
    await expect(oversized.listSessions()).rejects.toMatchObject({ kind: "transport" });
  });
});
