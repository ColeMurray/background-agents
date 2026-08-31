// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuthSession } from "@/lib/auth-session";
import { AppAuthBoundary } from "./app-auth-boundary";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";

expect.extend(matchers);

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: vi.fn(),
}));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: vi.fn(),
}));

const activeAuthorization = {
  userId: "11111111111111111111111111111111",
  suspendedAt: null,
  role: { id: "role_builtin_member", key: "member" as const, name: "Member" },
  permissions: ["repositories.read" as const],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(useCurrentUserAuthorization).mockReturnValue({
    authorization: null,
    loading: false,
    error: null,
    hasPermission: () => false,
  });
});

describe("AppAuthBoundary", () => {
  it("renders the app only for authenticated users", () => {
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user-1", name: "Test User" } },
      status: "authenticated",
    });
    vi.mocked(useCurrentUserAuthorization).mockReturnValue({
      authorization: activeAuthorization,
      loading: false,
      error: null,
      hasPermission: () => true,
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

  it("fails closed when workspace access is suspended", () => {
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user-1", name: "Test User" } },
      status: "authenticated",
    });
    vi.mocked(useCurrentUserAuthorization).mockReturnValue({
      authorization: { ...activeAuthorization, suspendedAt: 1, permissions: [] },
      loading: false,
      error: null,
      hasPermission: () => false,
    });

    render(<AppAuthBoundary>Session</AppAuthBoundary>);

    expect(screen.getByRole("alert")).toHaveTextContent("Your workspace access is disabled.");
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
