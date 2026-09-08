// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerAuthSession: vi.fn(),
  getEnabledSignInProviders: vi.fn(),
  signIn: vi.fn(),
}));

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: mocks.getServerAuthSession }));
vi.mock("@/lib/sign-in-providers", () => ({
  getEnabledSignInProviders: mocks.getEnabledSignInProviders,
}));
vi.mock("@/lib/auth-session", () => ({ signIn: mocks.signIn }));

import AuthorizePage, { dynamic } from "./page";

expect.extend(matchers);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getServerAuthSession.mockResolvedValue(null);
  mocks.getEnabledSignInProviders.mockResolvedValue(["github", "google"]);
});

afterEach(cleanup);

describe("CLI authorize page", () => {
  it("normalizes the code and offers configured sign-in providers with the exact callback", async () => {
    render(await AuthorizePage({ searchParams: Promise.resolve({ user_code: "  abcd-efgh  " }) }));

    expect(screen.getByText("ABCD-EFGH")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
    expect(screen.getByText(/sign in before choosing whether to approve/i)).toBeInTheDocument();
  });

  it("shows an invalid state without querying auth for a malformed code", async () => {
    render(await AuthorizePage({ searchParams: Promise.resolve({ user_code: "bad" }) }));

    expect(screen.getByRole("alert")).toHaveTextContent("This authorization link is invalid.");
    expect(mocks.getServerAuthSession).not.toHaveBeenCalled();
    expect(mocks.getEnabledSignInProviders).not.toHaveBeenCalled();
  });

  it("shows the authenticated identity and explicit approval controls", async () => {
    mocks.getServerAuthSession.mockResolvedValue({
      user: { id: "user-1", name: "Ada", email: "ada@example.com", image: null },
    });

    render(await AuthorizePage({ searchParams: Promise.resolve({ user_code: "ABCD-EFGH" }) }));

    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(mocks.getEnabledSignInProviders).not.toHaveBeenCalled();
  });

  it("is request-time rendered", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});
