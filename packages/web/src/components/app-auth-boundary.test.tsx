// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { useState } from "react";
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

let composerMounts = 0;

/** Stands in for the prompt composer: unsaved draft text held in React state. */
function DraftComposer() {
  const [draft] = useState(() => `draft-${++composerMounts}`);
  return <div data-testid="draft">{draft}</div>;
}

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

  it("keeps the app mounted when a revalidation fails but authorization is cached", () => {
    composerMounts = 0;
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user-1", name: "Test User" } },
      status: "authenticated",
    });
    const cached = {
      authorization: activeAuthorization,
      loading: false,
      hasPermission: () => true,
    };
    vi.mocked(useCurrentUserAuthorization).mockReturnValue({ ...cached, error: null });

    // A fresh element every time: React bails out of re-rendering an identical
    // element reference, which would hide the state change under test.
    const tree = () => (
      <AppAuthBoundary>
        <DraftComposer />
      </AppAuthBoundary>
    );
    const { rerender } = render(tree());
    expect(screen.getByTestId("draft")).toHaveTextContent("draft-1");

    // A failed revalidation: SWR reports the error but retains the cached value.
    vi.mocked(useCurrentUserAuthorization).mockReturnValue({
      ...cached,
      error: new Error("Authorization request failed (500)"),
    });
    rerender(tree());
    expect(screen.getByTestId("draft")).toHaveTextContent("draft-1");

    // The retry succeeds; the subtree must never have remounted.
    vi.mocked(useCurrentUserAuthorization).mockReturnValue({ ...cached, error: null });
    rerender(tree());
    expect(screen.getByTestId("draft")).toHaveTextContent("draft-1");
    expect(composerMounts).toBe(1);
  });

  it("fails closed when authorization has never resolved", () => {
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user-1", name: "Test User" } },
      status: "authenticated",
    });
    vi.mocked(useCurrentUserAuthorization).mockReturnValue({
      authorization: null,
      loading: false,
      error: new Error("Authorization request failed (500)"),
      hasPermission: () => false,
    });

    render(<AppAuthBoundary>Session</AppAuthBoundary>);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Authorization is temporarily unavailable."
    );
    expect(screen.queryByText("Session")).not.toBeInTheDocument();
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
