// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { createRef, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { SandboxBootPhase } from "@open-inspect/shared/types/sandbox-events";
import type { SessionState } from "@open-inspect/shared/types/server-messages";
import type { SessionCapabilities } from "@/lib/session-capabilities";
import { actions, createSessionState, SessionHeader } from "./session-header.test-fixtures";

type ConnectionProps = Pick<
  ComponentProps<typeof SessionHeader>,
  "connected" | "connecting" | "reconnecting"
>;

expect.extend(matchers);

vi.mock("@/components/sidebar-layout", () => ({
  useSidebarContext: () => ({
    isOpen: true,
    toggle: vi.fn(),
  }),
}));

afterEach(cleanup);

describe("SessionHeader connection and mobile controls", () => {
  it("replaces the phone Details control with the unified actions menu", () => {
    const onToggleDetails = vi.fn();
    const onOpenMobileDetails = vi.fn();
    const onOpenMobileMedia = vi.fn();
    render(
      <SessionHeader
        sessionState={null}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Mobile menu" }}
        connected
        connecting={false}
        isDetailsOpen={false}
        isDesktopDetailsOpen
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={onToggleDetails}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={onOpenMobileDetails}
        onOpenMobileMedia={onOpenMobileMedia}
        actions={{
          ...actions,
          artifacts: [{ id: "shot-1", type: "screenshot", url: null, createdAt: 1 }],
        }}
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

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "Media (1)" }));
    expect(onOpenMobileMedia).toHaveBeenCalledOnce();
    expect(onOpenMobileDetails).toHaveBeenCalledOnce();
  });

  it("renders separate status icons and reveals the connection label on hover", async () => {
    render(
      <SessionHeader
        sessionState={createSessionState()}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Status icons" }}
        connected
        connecting={false}
        isDetailsOpen={false}
        isDesktopDetailsOpen
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        onOpenMobileMedia={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    const connection = screen.getByRole("status", { name: "Connection status: Connected" });
    expect(connection.parentElement).not.toHaveClass("md:hidden");
    expect(connection).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("button", { name: "Sandbox status: Ready" })).toBeInTheDocument();

    fireEvent.pointerMove(connection, { pointerType: "mouse" });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Connected");
  });

  it("reveals the connection label on keyboard focus", async () => {
    render(
      <SessionHeader
        sessionState={createSessionState()}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Status icons" }}
        connected
        connecting={false}
        isDetailsOpen={false}
        isDesktopDetailsOpen
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        onOpenMobileMedia={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    fireEvent.focus(screen.getByRole("status", { name: "Connection status: Connected" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Connected");
  });

  it("labels connecting and disconnected mobile connection states", () => {
    const props = {
      sessionState: createSessionState(),
      fallbackSessionInfo: { repoOwner: "acme", repoName: "web", title: "Status icons" },
      isDetailsOpen: false,
      isDesktopDetailsOpen: true,
      detailsButtonRef: createRef<HTMLButtonElement>(),
      actionsButtonRef: createRef<HTMLButtonElement>(),
      onToggleDetails: vi.fn(),
      onToggleDesktopDetails: vi.fn(),
      onOpenMobileDetails: vi.fn(),
      onOpenMobileMedia: vi.fn(),
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

  it("labels a pending reconnect distinctly from a first connection", () => {
    const props = {
      sessionState: createSessionState(),
      fallbackSessionInfo: { repoOwner: "acme", repoName: "web", title: "Status icons" },
      isDetailsOpen: false,
      isDesktopDetailsOpen: true,
      detailsButtonRef: createRef<HTMLButtonElement>(),
      actionsButtonRef: createRef<HTMLButtonElement>(),
      onToggleDetails: vi.fn(),
      onToggleDesktopDetails: vi.fn(),
      onOpenMobileDetails: vi.fn(),
      onOpenMobileMedia: vi.fn(),
      actions,
      renameSession: vi.fn(),
    };
    render(<SessionHeader {...props} connected={false} connecting={false} reconnecting />);

    expect(
      screen.getByRole("status", { name: "Connection status: Reconnecting..." })
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
        isDesktopDetailsOpen
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        onOpenMobileMedia={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    const trigger = screen.getByRole("button", { name: "Sandbox status: Failed" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);

    // Scoped to the popover: the mobile attention strip names the same status,
    // and only this popover carries the dashboard link.
    const popover = within(screen.getByRole("dialog"));
    expect(popover.getByText("Sandbox Failed")).toBeInTheDocument();
    expect(popover.getByRole("link", { name: /Open provider dashboard/ })).toHaveAttribute(
      "href",
      "https://modal.com/apps/acme/main/sandbox"
    );
  });
});

describe("SessionHeader mobile presentation", () => {
  function renderMobileHeader(
    sessionState: SessionState,
    connection: Partial<ConnectionProps> = {},
    sandboxError?: string,
    capabilities?: SessionCapabilities,
    bootPhase?: SandboxBootPhase
  ) {
    return render(
      <SessionHeader
        sessionState={sessionState}
        sandboxError={sandboxError}
        capabilities={capabilities}
        bootPhase={bootPhase}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Mobile header" }}
        connected
        connecting={false}
        {...connection}
        isDetailsOpen={false}
        isDesktopDetailsOpen={false}
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        onOpenMobileMedia={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );
  }

  it("keeps the repository out of the mobile bar", () => {
    renderMobileHeader(createSessionState({ sandboxStatus: "ready" }));

    // The desktop header still carries it; the mobile bar hides that element.
    expect(screen.getByText("acme/web")).toHaveClass("hidden");
  });

  it("says nothing about a healthy sandbox", () => {
    renderMobileHeader(createSessionState({ sandboxStatus: "ready" }));

    expect(screen.queryByRole("button", { name: /^Show sandbox status/ })).not.toBeInTheDocument();
  });

  it("shows sandbox reconnecting on desktop and mobile while the browser stays connected", () => {
    renderMobileHeader(createSessionState({ sandboxConnectionStatus: "reconnecting" }));

    const desktop = screen.getByRole("status", { name: "Sandbox connection status" });
    expect(desktop).toHaveTextContent("Sandbox reconnecting");
    expect(desktop.parentElement).toHaveClass("hidden", "md:flex");
    const mobile = screen.getAllByRole("status").find((el) => !el.getAttribute("aria-label"));
    expect(mobile).toHaveClass("md:hidden");
    expect(mobile).toHaveTextContent("Sandbox reconnecting");
    expect(
      screen.getByRole("status", { name: "Connection status: Connected" })
    ).toBeInTheDocument();
  });

  it.each(["connected", undefined] as const)(
    "does not warn when sandbox bridge health is %s",
    (sandboxConnectionStatus) => {
      renderMobileHeader(createSessionState({ sandboxConnectionStatus }));
      expect(screen.queryByText("Sandbox reconnecting")).not.toBeInTheDocument();
    }
  );

  it("prioritizes browser reconnecting over stale sandbox bridge health", () => {
    renderMobileHeader(createSessionState({ sandboxConnectionStatus: "reconnecting" }), {
      connected: false,
      reconnecting: true,
    });

    expect(screen.queryByText("Sandbox reconnecting")).not.toBeInTheDocument();
    expect(screen.getByText("Reconnecting...")).toBeInTheDocument();
  });

  it("raises a strip while a ready sandbox is saving before a graceful stop", () => {
    renderMobileHeader(
      createSessionState({
        sandboxStatus: "ready",
        sandboxPreservation: { phase: "capturing", expiresAtMs: 2, drainAtMs: 1 },
      })
    );

    expect(
      screen.getByRole("button", { name: "Show sandbox status: Saving..." })
    ).toBeInTheDocument();
  });

  it("raises a strip for a sandbox that needs attention", () => {
    renderMobileHeader(createSessionState({ sandboxStatus: "failed" }));

    expect(screen.getByRole("button", { name: "Show sandbox status: Failed" })).toBeInTheDocument();
  });

  it.each([
    "pending",
    "warming",
    "spawning",
    "connecting",
    "snapshotting",
    "stopped",
    "stale",
  ] as const)("raises a strip for a %s sandbox", (sandboxStatus) => {
    renderMobileHeader(createSessionState({ sandboxStatus }));

    expect(screen.getByRole("button", { name: /^Show sandbox status/ })).toBeInTheDocument();
  });

  it("opens the same status detail from the strip as the desktop icon", () => {
    renderMobileHeader(
      createSessionState({
        sandboxStatus: "failed",
        sandboxDashboardUrl: "https://modal.com/apps/acme/main/sandbox",
      })
    );

    const strip = screen.getByRole("button", { name: "Show sandbox status: Failed" });
    fireEvent.pointerDown(strip, { button: 0, ctrlKey: false });
    fireEvent.click(strip);

    const popover = within(screen.getByRole("dialog"));
    expect(popover.getByText("Sandbox Failed")).toBeInTheDocument();
    expect(popover.getByRole("link", { name: /Open provider dashboard/ })).toHaveAttribute(
      "href",
      "https://modal.com/apps/acme/main/sandbox"
    );
  });

  it("reports a dropped connection ahead of the sandbox", () => {
    renderMobileHeader(createSessionState({ sandboxStatus: "failed" }), {
      connected: false,
      connecting: false,
      reconnecting: false,
    });

    expect(screen.getByText("Disconnected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Show sandbox status/ })).not.toBeInTheDocument();
  });

  it.each([
    ["connecting", { connected: false, connecting: true, reconnecting: false }, "Connecting..."],
    [
      "reconnecting",
      { connected: false, connecting: false, reconnecting: true },
      "Reconnecting...",
    ],
  ] as const)(
    "reports an in-progress %s socket rather than going silent",
    (_name, connection, label) => {
      renderMobileHeader(createSessionState({ sandboxStatus: "ready" }), connection);

      // A retry budget that spans minutes must not read as a frozen app.
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.queryByText("Disconnected")).not.toBeInTheDocument();
    }
  );

  it("keeps the live region mounted with nothing to report", () => {
    renderMobileHeader(createSessionState({ sandboxStatus: "ready" }));

    // A region inserted in the same commit as its first text is commonly not
    // announced, so it has to outlive the quiet state. The desktop connection
    // dot is also role=status but carries an aria-label; this one does not.
    const regions = screen.getAllByRole("status").filter((el) => !el.getAttribute("aria-label"));
    expect(regions).toHaveLength(1);
    expect(regions[0]).toBeEmptyDOMElement();
  });

  it("fills the same live region when a status arrives", () => {
    const { rerender } = renderMobileHeader(createSessionState({ sandboxStatus: "ready" }));
    const before = screen.getAllByRole("status").filter((el) => !el.getAttribute("aria-label"))[0];

    rerender(
      <SessionHeader
        sessionState={createSessionState({ sandboxStatus: "spawning" })}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Mobile header" }}
        connected
        connecting={false}
        isDetailsOpen={false}
        isDesktopDetailsOpen={false}
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        onOpenMobileMedia={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    const after = screen.getAllByRole("status").filter((el) => !el.getAttribute("aria-label"))[0];
    expect(after).toBe(before);
    expect(after).toHaveTextContent("Sandbox Starting...");
  });

  it("reaches the status detail and dashboard link for a healthy sandbox", async () => {
    renderMobileHeader(
      createSessionState({
        sandboxStatus: "ready",
        sandboxDashboardUrl: "https://modal.com/apps/acme/main/sandbox",
      })
    );

    // Nothing is on the bar in this state, so the actions menu has to carry it.
    fireEvent.pointerDown(screen.getByRole("button", { name: "Session actions" }), {
      button: 0,
      ctrlKey: false,
    });

    const menu = within(await screen.findByRole("menu"));
    expect(menu.getByText("Sandbox Ready")).toBeInTheDocument();
    expect(menu.getByText("The sandbox is available.")).toBeInTheDocument();
    expect(menu.getByRole("menuitem", { name: /Open provider dashboard/ })).toHaveAttribute(
      "href",
      "https://modal.com/apps/acme/main/sandbox"
    );
  });

  it("names the step that broke in the actions menu", async () => {
    // The strip yields to the connection line here, so the menu is the only
    // place left that can say which boot step failed.
    renderMobileHeader(
      createSessionState({ sandboxStatus: "failed" }),
      { connected: false, connecting: false, reconnecting: false },
      undefined,
      undefined,
      { phase: "sync", status: "failed" }
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Session actions" }), {
      button: 0,
      ctrlKey: false,
    });

    expect(
      within(await screen.findByRole("menu")).getByText("Failed while cloning repository.")
    ).toBeInTheDocument();
  });

  it("puts the provider's failure reason in the actions menu", async () => {
    renderMobileHeader(createSessionState({ sandboxStatus: "failed" }), {}, "Quota exceeded.");

    fireEvent.pointerDown(screen.getByRole("button", { name: "Session actions" }), {
      button: 0,
      ctrlKey: false,
    });

    expect(
      within(await screen.findByRole("menu")).getByText("Quota exceeded.")
    ).toBeInTheDocument();
  });

  it("withholds the dashboard link from a session without sandbox access", async () => {
    renderMobileHeader(
      createSessionState({
        sandboxStatus: "ready",
        sandboxDashboardUrl: "https://modal.com/apps/acme/main/sandbox",
      }),
      {},
      undefined,
      {
        read: true,
        collaborate: false,
        lifecycle: false,
        delete: false,
        manageCollaborators: false,
        changeVisibility: false,
        sandboxAccess: false,
        exportTrace: false,
      }
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Session actions" }), {
      button: 0,
      ctrlKey: false,
    });

    const menu = within(await screen.findByRole("menu"));
    expect(menu.getByText("Sandbox Ready")).toBeInTheDocument();
    expect(
      menu.queryByRole("menuitem", { name: /Open provider dashboard/ })
    ).not.toBeInTheDocument();
  });
});
