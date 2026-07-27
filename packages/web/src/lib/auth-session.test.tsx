// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  useSWR: vi.fn(),
}));

vi.mock("swr", () => ({
  default: mocks.useSWR,
  mutate: mocks.mutate,
}));

import {
  signIn,
  signOut,
  useAuthSession,
  type AuthSession,
  type AuthSessionState,
} from "./auth-session";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("useAuthSession", () => {
  it("keeps session data correlated with authentication status", () => {
    function assertState(state: AuthSessionState) {
      if (state.status === "authenticated") {
        expectTypeOf(state.data).toEqualTypeOf<AuthSession>();
        return;
      }

      expectTypeOf(state.data).toEqualTypeOf<null>();
    }

    assertState({ status: "loading", data: null });
  });

  it("exposes the Better Auth session through the app-owned hook", () => {
    const data = {
      user: {
        id: "user-1",
        name: "Ada",
        email: "ada@example.com",
        image: null,
      },
      session: {
        id: "session-1",
        userId: "user-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    };
    mocks.useSWR.mockReturnValue({
      data,
      error: undefined,
      isLoading: false,
    });

    const { result } = renderHook(() => useAuthSession());

    expect(result.current).toEqual({
      data,
      status: "authenticated",
    });
  });

  it("exposes no session data while Better Auth is loading", () => {
    mocks.useSWR.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
    });

    const { result } = renderHook(() => useAuthSession());

    expect(result.current).toEqual({
      data: null,
      status: "loading",
    });
  });

  it("treats a completed empty response as unauthenticated", () => {
    mocks.useSWR.mockReturnValue({
      data: null,
      error: undefined,
      isLoading: false,
    });

    const { result } = renderHook(() => useAuthSession());

    expect(result.current).toEqual({
      data: null,
      status: "unauthenticated",
    });
  });

  it("fails closed without crashing when the session lookup fails", () => {
    mocks.useSWR.mockReturnValue({
      data: undefined,
      error: new Error("control plane unavailable"),
      isLoading: false,
    });

    const { result } = renderHook(() => useAuthSession());

    expect(result.current).toEqual({
      data: null,
      status: "unauthenticated",
    });
  });

  it("retains a cached authenticated session during a failed revalidation", () => {
    const data: AuthSession = {
      user: {
        id: "user-1",
        name: "Ada",
        email: "ada@example.com",
        image: null,
      },
    };
    mocks.useSWR.mockReturnValue({
      data,
      error: new Error("transient revalidation failure"),
      isLoading: false,
    });

    const { result } = renderHook(() => useAuthSession());

    expect(result.current).toEqual({
      data,
      status: "authenticated",
    });
  });
});

describe("signIn", () => {
  it("starts a proxied Better Auth provider flow", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        url: "https://github.com/login/oauth/authorize?state=state",
        redirect: true,
      })
    );
    const assign = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", {
      origin: "https://app.example",
      assign,
    });

    await signIn("github");

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/sign-in/social", {
      method: "POST",
      mode: "same-origin",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        callbackURL: "/",
        disableRedirect: true,
      }),
    });
    expect(assign).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?state=state");
  });

  it("throws instead of navigating when sign-in fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ error: "Unavailable" }, { status: 503 }))
    );
    vi.stubGlobal("location", { origin: "https://app.example", assign: vi.fn() });

    await expect(signIn("google")).rejects.toThrow("Sign-in failed with status 503");
    expect(location.assign).not.toHaveBeenCalled();
  });
});

describe("signOut", () => {
  it("ends the Better Auth session and clears the session cache", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true }));
    vi.stubGlobal("fetch", fetchMock);

    await signOut();

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/sign-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      mode: "same-origin",
      credentials: "same-origin",
    });
    expect(mocks.mutate).toHaveBeenCalledWith("/api/auth/get-session", null, false);
  });

  it("does not clear local state when server-side sign-out fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ error: "Unavailable" }, { status: 503 }))
    );

    await expect(signOut()).rejects.toThrow("Sign-out failed with status 503");
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
