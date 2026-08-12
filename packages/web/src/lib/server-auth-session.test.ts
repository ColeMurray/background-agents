import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  dispatchBrowserAuthRequest: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("./browser-auth-proxy", () => ({
  dispatchBrowserAuthRequest: mocks.dispatchBrowserAuthRequest,
}));

import { getServerAuthSession, type ServerAuthSession } from "./server-auth-session";
import { AuthenticationUnavailableError } from "./authentication-unavailable-error";

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
        id: "0123456789abcdef0123456789abcdef",
        name: "Ada",
        email: "ada@example.com",
        image: "https://images.example/ada",
      },
      session: {
        id: "session-1",
        userId: "0123456789abcdef0123456789abcdef",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    };
    mocks.dispatchBrowserAuthRequest.mockResolvedValue(Response.json(session));

    await expect(getServerAuthSession()).resolves.toEqual({ user: session.user });

    expect(mocks.dispatchBrowserAuthRequest).toHaveBeenCalledWith({
      method: "GET",
      pathname: "/api/auth/get-session",
      headers: {
        Cookie: "__Secure-openinspect.session_token=session.signature",
      },
    });
  });

  it("returns null without dispatching when the browser session cookie is absent", async () => {
    mocks.cookies.mockResolvedValue({
      getAll: () => [{ name: "__Secure-openinspect.state", value: "oauth-state" }],
    });

    await expect(getServerAuthSession()).resolves.toBeNull();
    expect(mocks.dispatchBrowserAuthRequest).not.toHaveBeenCalled();
  });

  it("propagates cookie access failures without wrapping or dispatching", async () => {
    const frameworkSignal = new Error("NEXT_DYNAMIC_API_SIGNAL");
    mocks.cookies.mockRejectedValue(frameworkSignal);

    await expect(getServerAuthSession()).rejects.toBe(frameworkSignal);
    expect(mocks.dispatchBrowserAuthRequest).not.toHaveBeenCalled();
  });

  it("returns null when Better Auth rejects the browser session", async () => {
    mocks.dispatchBrowserAuthRequest.mockResolvedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );

    await expect(getServerAuthSession()).resolves.toBeNull();
  });

  it("returns null when Better Auth reports no current session", async () => {
    mocks.dispatchBrowserAuthRequest.mockResolvedValue(Response.json(null));

    await expect(getServerAuthSession()).resolves.toBeNull();
  });

  it("reports auth-service failure as explicit unavailability instead of logout", async () => {
    mocks.dispatchBrowserAuthRequest.mockResolvedValue(
      Response.json({ error: "Unavailable" }, { status: 503 })
    );

    await expect(getServerAuthSession()).rejects.toBeInstanceOf(AuthenticationUnavailableError);
  });

  it("rejects malformed successful session responses", async () => {
    mocks.dispatchBrowserAuthRequest.mockResolvedValue(
      Response.json({ user: { id: 42 }, session: { userId: "user-1" } })
    );

    await expect(getServerAuthSession()).rejects.toThrow();
  });

  it("rejects a noncanonical browser user id", async () => {
    mocks.dispatchBrowserAuthRequest.mockResolvedValue(
      Response.json({
        user: { id: "better-auth-default-id" },
        session: {
          id: "session-1",
          userId: "better-auth-default-id",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      })
    );

    const error = await getServerAuthSession().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AuthenticationUnavailableError);
    expect(String((error as AuthenticationUnavailableError).cause)).toContain(
      "Browser session user id is not canonical"
    );
  });

  it("exposes an app-owned session contract", () => {
    expectTypeOf(getServerAuthSession).returns.toEqualTypeOf<Promise<ServerAuthSession | null>>();
  });
});
