// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import {
  actions,
  createSessionState,
  FULL_CAPABILITIES,
  SessionHeader,
} from "./session-header.test-fixtures";

expect.extend(matchers);

vi.mock("@/components/sidebar-layout", () => ({
  useSidebarContext: () => ({
    isOpen: true,
    toggle: vi.fn(),
  }),
}));

afterEach(cleanup);

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
  it("removes an open rename editor when lifecycle capability is revoked", () => {
    const props = {
      sessionState: createSessionState(),
      fallbackSessionInfo: { repoOwner: "acme", repoName: "web", title: "Session 1" },
      connected: true,
      connecting: false,
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
    const { rerender } = render(<SessionHeader {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Session 1" }));
    expect(screen.getByRole("textbox", { name: "Session title" })).toBeInTheDocument();
    rerender(
      <SessionHeader {...props} capabilities={{ ...FULL_CAPABILITIES, lifecycle: false }} />
    );
    expect(screen.queryByRole("textbox", { name: "Session title" })).not.toBeInTheDocument();
    expect(props.renameSession).not.toHaveBeenCalled();
  });
  it("gives the desktop title available header space instead of a fixed width", () => {
    const title = "Correctness review of background agents";
    render(
      <SessionHeader
        sessionState={createSessionState({ title })}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title }}
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

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).not.toHaveClass("md:max-w-40");
    expect(heading.parentElement).not.toHaveClass("md:flex-initial");
    expect(heading.parentElement?.parentElement).not.toHaveClass("md:flex-initial");
    expect(screen.getByText("acme/web")).toHaveClass("truncate");

    fireEvent.click(screen.getByRole("button", { name: title }));
    const input = screen.getByRole("textbox", { name: "Session title" });
    expect(input).toHaveClass("w-full");
    expect(input).not.toHaveClass("md:max-w-40");
  });

  it("disables lifecycle controls and connection UI for a read-only session", async () => {
    render(
      <SessionHeader
        sessionState={createSessionState()}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Read only" }}
        connected={false}
        connecting={false}
        isDetailsOpen={false}
        isDesktopDetailsOpen
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        onOpenMobileMedia={vi.fn()}
        actions={{ ...actions, capabilities: { ...FULL_CAPABILITIES, lifecycle: false } }}
        renameSession={vi.fn()}
        capabilities={{
          read: false,
          collaborate: false,
          lifecycle: false,
          delete: false,
          manageCollaborators: false,
          changeVisibility: false,
          sandboxAccess: false,
          exportTrace: false,
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
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={onToggleDesktopDetails}
        onOpenMobileDetails={vi.fn()}
        onOpenMobileMedia={vi.fn()}
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
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onToggleDesktopDetails={onToggleDesktopDetails}
        onOpenMobileDetails={vi.fn()}
        onOpenMobileMedia={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    const showButton = screen.getByRole("button", { name: "Show session details" });
    expect(showButton).toHaveAttribute("aria-expanded", "false");
    expect(showButton.querySelector('line[x1="15"][x2="15"]')).toBeInTheDocument();
    expect(showButton.querySelector('path[fill="currentColor"]')).not.toBeInTheDocument();
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

    expect(screen.getByRole("button", { name: "Incident sweep" })).toBeInTheDocument();
    expect(screen.getByText("No repository")).toBeInTheDocument();
    expect(screen.queryByText("Loading session...")).not.toBeInTheDocument();
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

    expect(screen.getByRole("button", { name: "Sandbox status: Ready" })).toBeInTheDocument();
  });

  it.each([
    ["draining", "Saving..."],
    ["prepared", "Saving..."],
    ["capturing", "Saving..."],
    ["retiring", "Saving..."],
    ["running", "Ready"],
    ["restoring", "Ready"],
  ] as const)("reports a ready sandbox in the %s shutdown phase as %s", (phase, label) => {
    render(
      <SessionHeader
        sessionState={createSessionState({
          sandboxStatus: "ready",
          sandboxPreservation: { phase, expiresAtMs: 2, drainAtMs: 1 },
        })}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Stopping" }}
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

    expect(screen.getByRole("button", { name: `Sandbox status: ${label}` })).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "Sandbox status: Failed" }));

    expect(await screen.findByText("The sandbox could not start or recover.")).toBeInTheDocument();
    expect(screen.queryByText(/Failed to create/)).not.toBeInTheDocument();
  });
});
