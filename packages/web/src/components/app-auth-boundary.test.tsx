// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuthSession } from "@/lib/auth-session";
import { AppAuthBoundary } from "./app-auth-boundary";

expect.extend(matchers);

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AppAuthBoundary", () => {
  it("renders the app only for authenticated users", () => {
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user-1", name: "Test User" } },
      status: "authenticated",
    });

    render(<AppAuthBoundary>Session</AppAuthBoundary>);

    expect(screen.getByText("Session")).toBeInTheDocument();
  });

  it("renders a loading state before authentication resolves", () => {
    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "loading" });

    render(<AppAuthBoundary>Session</AppAuthBoundary>);

    expect(screen.getByRole("status", { name: "Checking authentication" })).toBeInTheDocument();
    expect(screen.queryByText("Session")).not.toBeInTheDocument();
  });

  it("links unauthenticated users to the provider-aware login route", () => {
    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "unauthenticated" });

    render(<AppAuthBoundary>Session</AppAuthBoundary>);

    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    expect(screen.queryByText("Session")).not.toBeInTheDocument();
  });

  it("fails closed when authentication is unavailable", () => {
    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "unavailable" });

    render(<AppAuthBoundary>Session</AppAuthBoundary>);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Authentication is temporarily unavailable."
    );
    expect(screen.queryByRole("link", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("fails closed for an unhandled authentication state", () => {
    vi.mocked(useAuthSession).mockReturnValue({
      data: null,
      status: "future-state",
    } as never);

    expect(() => render(<AppAuthBoundary>Session</AppAuthBoundary>)).toThrow(
      "Unhandled authentication state"
    );
  });
});
