// @vitest-environment jsdom

import { cleanup, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

vi.mock("next-auth/react", () => ({
  SessionProvider: vi.fn(({ children }: { children?: ReactNode }) => children),
  signIn: vi.fn(),
  signOut: vi.fn(),
  useSession: vi.fn(),
}));

import {
  SessionProvider,
  signIn as nextAuthSignIn,
  signOut as nextAuthSignOut,
  useSession,
} from "next-auth/react";
import {
  AuthSessionProvider,
  signIn,
  signOut,
  useAuthSession,
  type AuthSession,
  type AuthSessionState,
} from "./auth-session";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
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

  it("exposes the current NextAuth session through the app-owned hook", () => {
    const data = {
      user: {
        id: "user-1",
        name: "Ada",
        email: "ada@example.com",
        image: null,
      },
      expires: "2099-01-01",
    };
    vi.mocked(useSession).mockReturnValue({
      data,
      status: "authenticated",
      update: vi.fn(),
    });

    const { result } = renderHook(() => useAuthSession());

    expect(result.current).toEqual({
      data,
      status: "authenticated",
    });
  });

  it("exposes no session data while NextAuth is loading", () => {
    vi.mocked(useSession).mockReturnValue({
      data: null,
      status: "loading",
      update: vi.fn(),
    });

    const { result } = renderHook(() => useAuthSession());

    expect(result.current).toEqual({
      data: null,
      status: "loading",
    });
  });
});

describe("AuthSessionProvider", () => {
  it("preserves the disabled NextAuth focus refetch behavior", () => {
    render(
      <AuthSessionProvider>
        <div>Application</div>
      </AuthSessionProvider>
    );

    expect(screen.getByText("Application")).toBeTruthy();
    expect(vi.mocked(SessionProvider).mock.calls[0]?.[0]).toMatchObject({
      refetchOnWindowFocus: false,
    });
  });
});

describe("signIn", () => {
  it("starts the existing NextAuth provider flow", async () => {
    vi.mocked(nextAuthSignIn).mockResolvedValue(undefined);

    await signIn("github");

    expect(nextAuthSignIn).toHaveBeenCalledWith("github");
  });
});

describe("signOut", () => {
  it("ends the existing NextAuth session", async () => {
    vi.mocked(nextAuthSignOut).mockResolvedValue(undefined);

    await signOut();

    expect(nextAuthSignOut).toHaveBeenCalledOnce();
  });
});
