// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { SessionState } from "@open-inspect/shared/types/server-messages";
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

function createSessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: "session-1",
    title: "Session 1",
    repoOwner: "acme",
    repoName: "web",
    baseBranch: "main",
    branchName: "feature/status-icons",
    status: "active",
    sandboxStatus: "ready",
    messageCount: 0,
    createdAt: 1,
    ...overrides,
  };
}

describe("SessionHeader", () => {
  it("renders no-repository fallback data as loaded while socket state is absent", () => {
    render(
      <SessionHeader
        sessionState={null}
        fallbackSessionInfo={{ repoOwner: null, repoName: null, title: "Incident sweep" }}
        connected={false}
        connecting={true}
        isDetailsOpen={false}
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Incident sweep" })).toBeInTheDocument();
    expect(screen.getByText("No repository")).toBeInTheDocument();
    expect(screen.queryByText("Loading session...")).not.toBeInTheDocument();
  });

  it("replaces the phone Details control with the unified actions menu", () => {
    const onToggleDetails = vi.fn();
    const onOpenMobileDetails = vi.fn();
    render(
      <SessionHeader
        sessionState={null}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Mobile menu" }}
        connected
        connecting={false}
        isDetailsOpen={false}
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={onToggleDetails}
        onOpenMobileDetails={onOpenMobileDetails}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Toggle session details" })).toHaveClass(
      "hidden",
      "md:block",
      "lg:hidden"
    );
    const trigger = screen.getByRole("button", { name: "Session actions" });
    expect(trigger.parentElement).toHaveClass("md:hidden");

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "Details" }));
    expect(onOpenMobileDetails).toHaveBeenCalledOnce();
    expect(onToggleDetails).not.toHaveBeenCalled();
  });

  it("renders separate mobile status icons and reveals the connection label on hover", async () => {
    render(
      <SessionHeader
        sessionState={createSessionState()}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Status icons" }}
        connected
        connecting={false}
        isDetailsOpen={false}
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    const connection = screen.getByRole("status", { name: "Connection status: Connected" });
    expect(connection.parentElement).toHaveClass("md:hidden");
    expect(connection).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("button", { name: "Sandbox status: Ready" })).toBeInTheDocument();

    fireEvent.pointerMove(connection, { pointerType: "mouse" });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Connected");
  });

  it("labels connecting and disconnected mobile connection states", () => {
    const props = {
      sessionState: createSessionState(),
      fallbackSessionInfo: { repoOwner: "acme", repoName: "web", title: "Status icons" },
      isDetailsOpen: false,
      detailsButtonRef: createRef<HTMLButtonElement>(),
      actionsButtonRef: createRef<HTMLButtonElement>(),
      onToggleDetails: vi.fn(),
      onOpenMobileDetails: vi.fn(),
      actions,
      renameSession: vi.fn(),
    };
    const { rerender } = render(<SessionHeader {...props} connected={false} connecting />);

    expect(
      screen.getByRole("status", { name: "Connection status: Connecting..." })
    ).toBeInTheDocument();

    rerender(<SessionHeader {...props} connected={false} connecting={false} />);
    expect(
      screen.getByRole("status", { name: "Connection status: Disconnected" })
    ).toBeInTheDocument();
  });

  it("opens mobile sandbox details with a safe provider dashboard link", () => {
    render(
      <SessionHeader
        sessionState={createSessionState({
          sandboxStatus: "failed",
          sandboxDashboardUrl: "https://modal.com/apps/acme/main/sandbox",
        })}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Status icons" }}
        connected
        connecting={false}
        isDetailsOpen={false}
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    const trigger = screen.getByRole("button", { name: "Sandbox status: Failed" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);

    expect(screen.getByText("Sandbox Failed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open provider dashboard/ })).toHaveAttribute(
      "href",
      "https://modal.com/apps/acme/main/sandbox"
    );
  });
});
