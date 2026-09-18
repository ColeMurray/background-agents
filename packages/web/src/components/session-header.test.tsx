// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { createRef, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { SessionState } from "@open-inspect/shared/types/server-messages";
import { SessionHeader as SessionHeaderComponent } from "./session-header";
import type { SessionActionProps } from "./session-actions";
import type { SessionCapabilities } from "@/lib/session-capabilities";

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

    expect(await screen.findByText("Sandbox Running setup.sh")).toBeInTheDocument();
    // One repository: naming it adds nothing.
    expect(screen.getByText("Running setup.sh.")).toBeInTheDocument();
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

    expect(await screen.findByText("Sandbox Connecting...")).toBeInTheDocument();
    expect(
      screen.getByText(
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

  it("shows the failed phase and the script's output tail inside the failed popover", async () => {
    render(
      <SessionHeader
        sessionState={createSessionState({ sandboxStatus: "failed" })}
        sandboxError="start hook failed for acme/web"
        bootPhase={{
          phase: "start",
          status: "failed",
          repoOwner: "acme",
          repoName: "web",
          outputTail: ["> web@1.0.0 dev", "npm ERR! missing script: dev"],
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
    const output = screen.getByRole("region", { name: "Boot output" });
    expect(output).toHaveTextContent("> web@1.0.0 dev npm ERR! missing script: dev");
    // The block scrolls, so keyboard users must be able to reach it.
    expect(output).toHaveAttribute("tabindex", "0");
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

    expect(screen.getByText("Sandbox Failed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open provider dashboard/ })).toHaveAttribute(
      "href",
      "https://modal.com/apps/acme/main/sandbox"
    );
  });
});
