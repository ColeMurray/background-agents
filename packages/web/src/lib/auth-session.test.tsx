// @vitest-environment jsdom

import { cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth/react", () => ({
  SessionProvider: vi.fn(({ children }: { children?: React.ReactNode }) => children),
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
import { AuthSessionProvider, signIn, signOut, useAuthSession } from "./auth-session";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("useAuthSession", () => {
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
