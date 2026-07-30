// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerAuthSession: vi.fn(),
  getEnabledSignInProviders: vi.fn(),
  redirect: vi.fn(),
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
}));

import { AuthenticationUnavailableError } from "@/lib/authentication-unavailable-error";
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
        mocks.getServerAuthSession.mockRejectedValue(
          new AuthenticationUnavailableError(new Error("sensitive session error"))
        );
      } else {
        mocks.getEnabledSignInProviders.mockRejectedValue(
          new AuthenticationUnavailableError(new Error("sensitive provider error"))
        );
      }

      render(await LoginPage());

      expect(screen.getByRole("alert")).toHaveTextContent("Sign-in is temporarily unavailable.");
      expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute("href", "/login");
      expect(screen.queryByText(/sensitive/)).not.toBeInTheDocument();
    }
  );

  it.each(["session", "providers"] as const)(
    "propagates unexpected errors from the %s seam",
    async (failure) => {
      const unexpectedError = new Error(`unexpected ${failure} failure`);
      if (failure === "session") {
        mocks.getServerAuthSession.mockRejectedValue(unexpectedError);
      } else {
        mocks.getEnabledSignInProviders.mockRejectedValue(unexpectedError);
      }

      await expect(LoginPage()).rejects.toBe(unexpectedError);
    }
  );

  it("is always rendered at request time", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});
