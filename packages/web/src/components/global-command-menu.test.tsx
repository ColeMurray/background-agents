// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalCommandMenu } from "./global-command-menu";

expect.extend(matchers);

Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});

const mocks = vi.hoisted(() => ({ repoImagesEnabled: true }));

vi.mock("@/hooks/use-keyboard-shortcuts", () => ({
  useKeyboardShortcuts: () => ({ labels: { "new-session": "Cmd/Ctrl+Shift+O" } }),
}));

vi.mock("@/lib/sandbox-provider", () => ({
  supportsRepoImages: () => mocks.repoImagesEnabled,
}));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  mocks.repoImagesEnabled = true;
  vi.unstubAllGlobals();
});

function renderMenu() {
  const onOpenChange = vi.fn();
  const onNavigate = vi.fn();
  const props = {
    onOpenChange,
    onNavigate,
    onNewSession: vi.fn(),
    sessions: [],
  };
  const view = render(<GlobalCommandMenu open {...props} />);
  return { ...view, onNavigate, onOpenChange, props };
}

describe("GlobalCommandMenu", () => {
  it("navigates directly to a settings destination", async () => {
    const user = userEvent.setup();
    const { onNavigate, onOpenChange } = renderMenu();

    await user.click(screen.getByText("Appearance"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onNavigate).toHaveBeenCalledWith("/settings?tab=appearance");
  });

  it("searches settings labels, descriptions, and keywords", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.type(
      screen.getByPlaceholderText("Search sessions, settings, and commands..."),
      "request source"
    );

    await waitFor(() => expect(screen.getByText("Source control")).toBeInTheDocument());
    expect(screen.queryByText("Appearance")).not.toBeInTheDocument();
  });

  it("does not show unrelated fuzzy settings matches", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.type(
      screen.getByPlaceholderText("Search sessions, settings, and commands..."),
      "theme"
    );

    await waitFor(() => expect(screen.getByText("Appearance")).toBeInTheDocument());
    expect(screen.queryByText("Source control")).not.toBeInTheDocument();
    expect(screen.queryByText("Models")).not.toBeInTheDocument();
  });

  it("clears settings filtering when the controlled dialog closes", async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderMenu();
    await user.type(
      screen.getByPlaceholderText("Search sessions, settings, and commands..."),
      "theme"
    );
    expect(screen.queryByText("Source control")).not.toBeInTheDocument();

    rerender(<GlobalCommandMenu open={false} {...props} />);
    rerender(<GlobalCommandMenu open {...props} />);

    await waitFor(() => expect(screen.getByText("Source control")).toBeInTheDocument());
  });

  it("omits unavailable settings destinations", () => {
    mocks.repoImagesEnabled = false;
    renderMenu();

    expect(screen.queryByText("Images")).not.toBeInTheDocument();
  });
});
