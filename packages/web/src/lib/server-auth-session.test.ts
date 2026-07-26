import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  proxyBrowserAuthRequest: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("./browser-auth-proxy", () => ({
  proxyBrowserAuthRequest: mocks.proxyBrowserAuthRequest,
}));

import { getServerAuthSession, type ServerAuthSession } from "./server-auth-session";

describe("getServerAuthSession", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.cookies.mockResolvedValue({
      getAll: () => [
        { name: "__Secure-openinspect.session_token", value: "session.signature" },
        { name: "__Secure-openinspect.state", value: "oauth-state" },
        { name: "unrelated", value: "do-not-forward" },
      ],
    });
  });

  it("resolves the app session through the signed browser-auth proxy", async () => {
    const session = {
      user: {
        id: "user-1",
        name: "Ada",
        email: "ada@example.com",
        image: "https://images.example/ada",
      },
      session: {
        id: "session-1",
        userId: "user-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    };
    mocks.proxyBrowserAuthRequest.mockResolvedValue(Response.json(session));

    await expect(getServerAuthSession()).resolves.toEqual({ user: session.user });

    const request = mocks.proxyBrowserAuthRequest.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe("GET");
    expect(new URL(request.url).pathname).toBe("/api/auth/get-session");
    expect(request.headers.get("Cookie")).toBe(
      "__Secure-openinspect.session_token=session.signature"
    );
  });

  it("returns null without dispatching when the browser session cookie is absent", async () => {
    mocks.cookies.mockResolvedValue({
      getAll: () => [{ name: "__Secure-openinspect.state", value: "oauth-state" }],
    });

    await expect(getServerAuthSession()).resolves.toBeNull();
    expect(mocks.proxyBrowserAuthRequest).not.toHaveBeenCalled();
  });

  it("returns null when Better Auth rejects the browser session", async () => {
    mocks.proxyBrowserAuthRequest.mockResolvedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );

    await expect(getServerAuthSession()).resolves.toBeNull();
  });

  it("returns null when Better Auth reports no current session", async () => {
    mocks.proxyBrowserAuthRequest.mockResolvedValue(Response.json(null));

    await expect(getServerAuthSession()).resolves.toBeNull();
  });

  it("throws when the auth service fails instead of treating failure as logout", async () => {
    mocks.proxyBrowserAuthRequest.mockResolvedValue(
      Response.json({ error: "Unavailable" }, { status: 503 })
    );

    await expect(getServerAuthSession()).rejects.toThrow(
      "Browser authentication failed with status 503"
    );
  });

  it("rejects malformed successful session responses", async () => {
    mocks.proxyBrowserAuthRequest.mockResolvedValue(
      Response.json({ user: { id: 42 }, session: { userId: "user-1" } })
    );

    await expect(getServerAuthSession()).rejects.toThrow();
  });

  it("exposes an app-owned session contract", () => {
    expectTypeOf(getServerAuthSession).returns.toEqualTypeOf<Promise<ServerAuthSession | null>>();
  });
});
