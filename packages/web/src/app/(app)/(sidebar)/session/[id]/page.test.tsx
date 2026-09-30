// @vitest-environment jsdom

import { Component, type PropsWithChildren } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import SessionPage from "./page";

const mocks = vi.hoisted(() => ({ socket: vi.fn(), prompt: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("./session-snapshot-provider", () => ({
  useSessionSnapshot: () => ({
    session: { id: "session-1", title: "Cached secret", harness: "opencode" },
  }),
}));
vi.mock("@/hooks/use-session-socket", () => ({ useSessionSocket: mocks.socket }));
vi.mock("@/hooks/use-prompt-input", () => ({ usePromptInput: mocks.prompt }));
vi.mock("@/hooks/use-keyboard-shortcuts", () => ({
  useKeyboardShortcuts: () => ({ shortcuts: {} }),
}));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({ hasPermission: () => true }),
}));

class NotFoundBoundary extends Component<PropsWithChildren, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error?.message === "NEXT_NOT_FOUND") return <p>404 Not Found</p>;
    if (this.state.error) return <p>Generic unavailable</p>;
    return this.props.children;
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("renders the existing not-found path before cached session content or action hooks", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.socket.mockReturnValue({ sessionGone: true });
  render(
    <NotFoundBoundary>
      <SessionPage />
    </NotFoundBoundary>
  );
  expect(screen.queryByText("404 Not Found")).not.toBeNull();
  expect(screen.queryByText("Cached secret")).toBeNull();
  expect(screen.queryByText("Generic unavailable")).toBeNull();
  expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  expect(mocks.prompt).not.toHaveBeenCalled();
});
