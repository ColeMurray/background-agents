// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SessionHeader } from "./session-header";
import type { SessionActionProps } from "./session-actions";

expect.extend(matchers);

vi.mock("@/components/sidebar-layout", () => ({
  useSidebarContext: () => ({
    isOpen: true,
    toggle: vi.fn(),
  }),
}));

afterEach(cleanup);

const actions: SessionActionProps = {
  sessionId: "session-1",
  sessionStatus: "active",
  artifacts: [],
};

const baseProps = {
  sessionState: null,
  fallbackSessionInfo: { repoOwner: "acme", repoName: "web", title: "Desktop details" },
  connected: true,
  connecting: false,
  isDetailsOpen: false,
  showDesktopDetailsToggle: true,
  detailsButtonRef: createRef<HTMLButtonElement>(),
  actionsButtonRef: createRef<HTMLButtonElement>(),
  onToggleDetails: vi.fn(),
  onToggleDesktopDetails: vi.fn(),
  onOpenMobileDetails: vi.fn(),
  actions,
  renameSession: vi.fn(),
};

describe("SessionHeader sidebar toggle icon", () => {
  it("uses a filled rail icon when the right sidebar is open", () => {
    render(<SessionHeader {...baseProps} isDesktopDetailsOpen />);
    const hideButton = screen.getByRole("button", { name: "Hide session details" });
    expect(hideButton.querySelector('[data-testid="right-sidebar-icon-open"]')).toBeInTheDocument();
    expect(hideButton.querySelector('rect[width="6"][height="18"]')).toBeInTheDocument();
  });

  it("keeps the existing outline icon when the right sidebar is closed", () => {
    render(<SessionHeader {...baseProps} isDesktopDetailsOpen={false} />);
    const showButton = screen.getByRole("button", { name: "Show session details" });
    expect(showButton.querySelector('[data-testid="right-sidebar-icon-open"]')).not.toBeInTheDocument();
    expect(showButton.querySelector('line[x1="15"][x2="15"]')).toBeInTheDocument();
    expect(showButton.querySelector('rect[width="6"][height="18"]')).not.toBeInTheDocument();
  });
});
