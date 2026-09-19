// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { createRef, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { SandboxBootPhase } from "@open-inspect/shared/types/sandbox-events";
import type { SessionState } from "@open-inspect/shared/types/server-messages";
import { SessionHeader as SessionHeaderComponent } from "./session-header";
import type { SessionActionProps } from "./session-actions";
import type { SessionCapabilities } from "@/lib/session-capabilities";

type ConnectionProps = Pick<
  ComponentProps<typeof SessionHeaderComponent>,
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

const FULL_CAPABILITIES: SessionCapabilities = {
  read: true,
  collaborate: true,
  lifecycle: true,
  sandboxAccess: true,
};

function SessionHeader({
  capabilities = FULL_CAPABILITIES,
  reconnecting = false,
  ...props
}: Omit<ComponentProps<typeof SessionHeaderComponent>, "capabilities" | "reconnecting"> & {
  capabilities?: SessionCapabilities;
  reconnecting?: boolean;
}) {
  return (
    <SessionHeaderComponent {...props} capabilities={capabilities} reconnecting={reconnecting} />
  );
}

const actions: SessionActionProps = {
  sessionId: "session-1",
  sessionStatus: "active",
  artifacts: [],
  capabilities: FULL_CAPABILITIES,
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
    harness: "opencode",
    messageCount: 0,
    createdAt: 1,
    ...overrides,
  };
}

function member(repoOwner: string, repoName: string, position: number) {
  return {
    position,
    repoOwner,
    repoName,
    repoId: position + 1,
    baseBranch: "main",
    branchName: null,
    baseSha: null,
    currentSha: null,
    prUrl: null,
  };
}

describe("SessionHeader", () => {
  it("disables lifecycle controls and connection UI for a read-only session", async () => {
    render(
      <SessionHeader
        sessionState={createSessionState()}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Read only" }}
        connected={false}
        connecting={false}
        isDetailsOpen={false}
        isDesktopDetailsOpen
        showDesktopDetailsToggle
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        actions={{ ...actions, capabilities: { ...FULL_CAPABILITIES, lifecycle: false } }}
        renameSession={vi.fn()}
        capabilities={{
          read: false,
          collaborate: false,
          lifecycle: false,
          sandboxAccess: false,
        }}
      />
    );

    expect(screen.getByRole("button", { name: "Session 1" })).toBeDisabled();
    expect(screen.queryByRole("status", { name: /Connection status/ })).not.toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: "Session actions" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect(screen.queryByRole("menuitem", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeInTheDocument();
  });
  it("lets desktop users hide and show the session details sidebar", () => {
    const onToggleDesktopDetails = vi.fn();
    const { rerender } = render(
      <SessionHeader
        sessionState={null}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Desktop details" }}
        connected
        connecting={false}
        isDetailsOpen={false}
        isDesktopDetailsOpen
        showDesktopDetailsToggle
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={onToggleDesktopDetails}
        onOpenMobileDetails={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    const hideButton = screen.getByRole("button", { name: "Hide session details" });
    const connectedStatus = screen.getByRole("status", { name: "Connection status: Connected" });
    expect(hideButton).toHaveClass("hidden", "lg:block");
    expect(hideButton).toHaveAttribute("aria-controls", "session-details-sidebar");
    expect(hideButton).toHaveAttribute("aria-expanded", "true");
    expect(hideButton.querySelector('path[fill="currentColor"]')).toBeInTheDocument();
    expect(
      connectedStatus.compareDocumentPosition(hideButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    fireEvent.click(hideButton);
    expect(onToggleDesktopDetails).toHaveBeenCalledOnce();

    rerender(
      <SessionHeader
        sessionState={null}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Desktop details" }}
        connected
        connecting={false}
        isDetailsOpen={false}
        isDesktopDetailsOpen={false}
        showDesktopDetailsToggle
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={onToggleDesktopDetails}
        onOpenMobileDetails={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    const showButton = screen.getByRole("button", { name: "Show session details" });
    expect(showButton).toHaveAttribute("aria-expanded", "false");
    expect(showButton.querySelector('line[x1="15"][x2="15"]')).toBeInTheDocument();
    expect(showButton.querySelector('path[fill="currentColor"]')).not.toBeInTheDocument();
  });

  it("hides the desktop details toggle while changes own the right-hand surface", () => {
    render(
      <SessionHeader
        sessionState={null}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Review changes" }}
        connected
        connecting={false}
        isDetailsOpen={false}
        isDesktopDetailsOpen
        showDesktopDetailsToggle={false}
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: "Hide session details" })).not.toBeInTheDocument();
  });

  it("renders no-repository fallback data as loaded while socket state is absent", () => {
    render(
      <SessionHeader
        sessionState={null}
        fallbackSessionInfo={{ repoOwner: null, repoName: null, title: "Incident sweep" }}
        connected={false}
        connecting={true}
        isDetailsOpen={false}
        isDesktopDetailsOpen
        showDesktopDetailsToggle
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
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
        isDesktopDetailsOpen
        showDesktopDetailsToggle
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={onToggleDetails}
        onToggleDesktopDetails={vi.fn()}
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

  it("renders separate status icons and reveals the connection label on hover", async () => {
    render(
      <SessionHeader
        sessionState={createSessionState()}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Status icons" }}
        connected
        connecting={false}
        isDetailsOpen={false}
        isDesktopDetailsOpen
        showDesktopDetailsToggle
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
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

  it("shows the provider's reason inside the failed sandbox popover", async () => {
    render(
      <SessionHeader
        sessionState={createSessionState({ sandboxStatus: "failed" })}
        sandboxError={
          'Failed to create E2B sandbox: {"code":400,"message":"Timeout cannot be greater than 1 hours"}'
        }
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Failed sandbox" }}
        connected
        connecting={false}
        isDetailsOpen={false}
        isDesktopDetailsOpen
        showDesktopDetailsToggle
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Sandbox status: Failed" }));

    // The generic label is not actionable on its own; the provider's message is
    // what tells someone the plan cap was exceeded.
    expect(await screen.findByText("The sandbox could not start or recover.")).toBeInTheDocument();
    expect(screen.getByText(/Timeout cannot be greater than 1 hours/)).toBeInTheDocument();
  });

  it("names the boot phase in progress instead of a generic connecting label", async () => {
    render(
      <SessionHeader
        sessionState={createSessionState({ sandboxStatus: "connecting" })}
        bootPhase={{ phase: "setup", status: "started", repoOwner: "acme", repoName: "web" }}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Booting" }}
        connected
        connecting={false}
        isDetailsOpen={false}
        isDesktopDetailsOpen
        showDesktopDetailsToggle
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Sandbox status: Running setup.sh" }));

    // Scoped to the popover: the mobile strip reports the same status too.
    const popover = within(await screen.findByRole("dialog"));
    expect(popover.getByText("Sandbox Running setup.sh")).toBeInTheDocument();
    // One repository: naming it adds nothing.
    expect(popover.getByText("Running setup.sh.")).toBeInTheDocument();
    expect(screen.queryByText("Sandbox status: Connecting...")).not.toBeInTheDocument();
  });

  it("names the repository a phase runs against in a multi-repository session", async () => {
    render(
      <SessionHeader
        sessionState={createSessionState({
          sandboxStatus: "spawning",
          repositories: [member("acme", "web", 0), member("acme", "api", 1)],
        })}
        bootPhase={{ phase: "start", status: "started", repoOwner: "acme", repoName: "api" }}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Booting" }}
        connected
        connecting={false}
        isDetailsOpen={false}
        isDesktopDetailsOpen
        showDesktopDetailsToggle
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Sandbox status: Starting services" }));

    expect(await screen.findByText("Running start.sh for acme/api.")).toBeInTheDocument();
  });

  it("keeps the status label for a completed phase and says what finished", async () => {
    // The runtime reports a tolerated non-zero exit on the completed phase.
    render(
      <SessionHeader
        sessionState={createSessionState({
          sandboxStatus: "connecting",
          repositories: [member("acme", "web", 0), member("acme", "api", 1)],
        })}
        bootPhase={{
          phase: "setup",
          status: "completed",
          warning: true,
          repoOwner: "acme",
          repoName: "api",
          elapsedMs: 91_200,
        }}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Booting" }}
        connected
        connecting={false}
        isDetailsOpen={false}
        isDesktopDetailsOpen
        showDesktopDetailsToggle
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    // Nothing is running between steps, so the pill does not claim it is.
    fireEvent.click(screen.getByRole("button", { name: "Sandbox status: Connecting..." }));

    // Scoped to the popover: the mobile strip reports the same status too.
    const popover = within(await screen.findByRole("dialog"));
    expect(popover.getByText("Sandbox Connecting...")).toBeInTheDocument();
    expect(
      popover.getByText(
        "Finished setup.sh for acme/api. This step exited with an error and the boot continued."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/Running setup.sh/)).not.toBeInTheDocument();
  });

  it("keeps the status label once the sandbox is past booting", () => {
    render(
      <SessionHeader
        sessionState={createSessionState({ sandboxStatus: "ready" })}
        bootPhase={{ phase: "harness", status: "completed" }}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Ready" }}
        connected
        connecting={false}
        isDetailsOpen={false}
        isDesktopDetailsOpen
        showDesktopDetailsToggle
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Sandbox status: Ready" })).toBeInTheDocument();
  });

  it("shows the failed phase metadata without a boot output region", async () => {
    render(
      <SessionHeader
        sessionState={createSessionState({ sandboxStatus: "failed" })}
        sandboxError="start hook failed for acme/web"
        bootPhase={{
          phase: "start",
          status: "failed",
          repoOwner: "acme",
          repoName: "web",
          detail: "start hook failed for acme/web",
        }}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Failed boot" }}
        connected
        connecting={false}
        isDetailsOpen={false}
        isDesktopDetailsOpen
        showDesktopDetailsToggle
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Sandbox status: Failed" }));

    expect(await screen.findByText("Failed while starting services.")).toBeInTheDocument();
    expect(screen.getByText("start hook failed for acme/web")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Boot output" })).not.toBeInTheDocument();
  });

  it("does not attribute a failure to a phase that had not failed", async () => {
    render(
      <SessionHeader
        sessionState={createSessionState({ sandboxStatus: "failed" })}
        sandboxError="Sandbox did not become ready within the boot budget"
        bootPhase={{ phase: "setup", status: "started" }}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Failed boot" }}
        connected
        connecting={false}
        isDetailsOpen={false}
        isDesktopDetailsOpen
        showDesktopDetailsToggle
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Sandbox status: Failed" }));

    expect(
      await screen.findByText("Sandbox did not become ready within the boot budget")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Failed while/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Boot output")).not.toBeInTheDocument();
  });

  it("omits the error block when the control plane reported no reason", async () => {
    render(
      <SessionHeader
        sessionState={createSessionState({ sandboxStatus: "failed" })}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Failed sandbox" }}
        connected
        connecting={false}
        isDetailsOpen={false}
        isDesktopDetailsOpen
        showDesktopDetailsToggle
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Sandbox status: Failed" }));

    expect(await screen.findByText("The sandbox could not start or recover.")).toBeInTheDocument();
    expect(screen.queryByText(/Failed to create/)).not.toBeInTheDocument();
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
        showDesktopDetailsToggle
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
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
      showDesktopDetailsToggle: true,
      detailsButtonRef: createRef<HTMLButtonElement>(),
      actionsButtonRef: createRef<HTMLButtonElement>(),
      onToggleDetails: vi.fn(),
      onToggleDesktopDetails: vi.fn(),
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

  it("labels a pending reconnect distinctly from a first connection", () => {
    const props = {
      sessionState: createSessionState(),
      fallbackSessionInfo: { repoOwner: "acme", repoName: "web", title: "Status icons" },
      isDetailsOpen: false,
      isDesktopDetailsOpen: true,
      showDesktopDetailsToggle: true,
      detailsButtonRef: createRef<HTMLButtonElement>(),
      actionsButtonRef: createRef<HTMLButtonElement>(),
      onToggleDetails: vi.fn(),
      onToggleDesktopDetails: vi.fn(),
      onOpenMobileDetails: vi.fn(),
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
        showDesktopDetailsToggle
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
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
        showDesktopDetailsToggle
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
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
        showDesktopDetailsToggle
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
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
      { read: true, collaborate: false, lifecycle: false, sandboxAccess: false }
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
