// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerAuthSession: vi.fn(),
  getEnabledSignInProviders: vi.fn(),
  redirect: vi.fn(),
  unstableRethrow: vi.fn(),
}));

vi.mock("@/lib/server-auth-session", () => ({
  getServerAuthSession: mocks.getServerAuthSession,
}));

vi.mock("@/lib/sign-in-providers", () => ({
  getEnabledSignInProviders: mocks.getEnabledSignInProviders,
}));

vi.mock("@/lib/auth-session", () => ({
  signIn: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  unstable_rethrow: mocks.unstableRethrow,
}));

import LoginPage, { dynamic } from "./page";

expect.extend(matchers);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getServerAuthSession.mockResolvedValue(null);
  mocks.getEnabledSignInProviders.mockResolvedValue(["github", "google"]);
});

afterEach(cleanup);

describe("LoginPage", () => {
  it("renders the request-time provider choices in the React application", async () => {
    render(await LoginPage());

    expect(screen.getByRole("heading", { name: "Sign in to Open-Inspect" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
  });

  it("redirects an authenticated user before querying providers", async () => {
    mocks.getServerAuthSession.mockResolvedValue({
      user: { id: "user-1", name: "Ada" },
    });
    mocks.redirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });

    await expect(LoginPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenCalledWith("/");
    expect(mocks.getEnabledSignInProviders).not.toHaveBeenCalled();
  });

  it.each(["session", "providers"] as const)(
    "renders a sanitized retryable unavailable state when %s resolution fails",
    async (failure) => {
      if (failure === "session") {
        mocks.getServerAuthSession.mockRejectedValue(new Error("sensitive session error"));
      } else {
        mocks.getEnabledSignInProviders.mockRejectedValue(new Error("sensitive provider error"));
      }

      render(await LoginPage());

      expect(screen.getByRole("alert")).toHaveTextContent("Sign-in is temporarily unavailable.");
      expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute("href", "/login");
      expect(screen.queryByText(/sensitive/)).not.toBeInTheDocument();
    }
  );

  it.each(["session", "providers"] as const)(
    "propagates Next.js control-flow errors from the %s seam",
    async (failure) => {
      const frameworkSignal = new Error(`NEXT_${failure.toUpperCase()}_SIGNAL`);
      mocks.unstableRethrow.mockImplementation((error: unknown) => {
        if (error === frameworkSignal) throw error;
      });
      if (failure === "session") {
        mocks.getServerAuthSession.mockRejectedValue(frameworkSignal);
      } else {
        mocks.getEnabledSignInProviders.mockRejectedValue(frameworkSignal);
      }

      await expect(LoginPage()).rejects.toBe(frameworkSignal);
      expect(mocks.unstableRethrow).toHaveBeenCalledWith(frameworkSignal);
    }
  );

  it("is always rendered at request time", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});
