// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "@open-inspect/shared/types/server-messages";
import { SessionDetailsOverlay } from "./session-details-overlay";
import { SessionRightSidebar } from "./session-right-sidebar";
import type { SessionCapabilities } from "@/lib/session-capabilities";

vi.mock("swr", () => ({ default: () => ({ data: undefined }) }));

afterEach(cleanup);

const FULL_CAPABILITIES: SessionCapabilities = {
  read: true,
  collaborate: true,
  lifecycle: true,
  sandboxAccess: true,
};

describe("SessionRightSidebar", () => {
  const sessionState: SessionState = {
    id: "session-1",
    title: null,
    repoOwner: null,
    repoName: null,
    baseBranch: null,
    branchName: null,
    status: "active",
    sandboxStatus: "ready",
    messageCount: 0,
    createdAt: 1,
    totalCost: 3,
    maxSessionCostUsd: 10,
  };

  it("hides sandbox access controls when the capability is denied", () => {
    const sandboxSessionState: SessionState = {
      id: "session-1",
      title: "Viewer session",
      repoOwner: "acme",
      repoName: "web",
      baseBranch: "main",
      branchName: "viewer",
      status: "active",
      sandboxStatus: "ready",
      messageCount: 0,
      createdAt: 1,
      codeServerUrl: "https://code.example",
      vncUrl: "https://vnc.example",
      ttydUrl: "https://terminal.example",
      ttydToken: "secret",
      tunnelUrls: { app: "https://app.example" },
    };

    render(
      <SessionRightSidebar
        sessionId="session-1"
        sessionState={sandboxSessionState}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={{ ...FULL_CAPABILITIES, sandboxAccess: false }}
      />
    );

    expect(screen.queryByText("Open Editor")).not.toBeInTheDocument();
    expect(screen.queryByText("Open Desktop")).not.toBeInTheDocument();
    expect(screen.queryByText("Terminal")).not.toBeInTheDocument();
    expect(screen.queryByText("Port app")).not.toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
  });
  it("keeps its ARIA target mounted when closed", () => {
    render(
      <SessionRightSidebar
        isOpen={false}
        sessionId="session-1"
        sessionState={null}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={FULL_CAPABILITIES}
      />
    );

    const sidebar = document.getElementById("session-details-sidebar");
    expect(sidebar).toBeInTheDocument();
    expect(sidebar).toHaveClass("hidden");
    expect(sidebar).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByText("details")).not.toBeInTheDocument();
  });

  it("forwards budget management to the desktop sidebar", () => {
    render(
      <SessionRightSidebar
        sessionId="session-1"
        sessionState={sessionState}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={FULL_CAPABILITIES}
        canManageBudget
      />
    );

    expect(screen.getByRole("button", { name: "Edit limit" })).toBeInTheDocument();
  });

  it("forwards budget management to the mobile overlay", () => {
    render(
      <SessionDetailsOverlay
        open
        isPhone
        onOpenChange={vi.fn()}
        sessionId="session-1"
        sessionState={sessionState}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={FULL_CAPABILITIES}
        canManageBudget
      />
    );

    expect(screen.getByRole("button", { name: "Edit limit" })).toBeInTheDocument();
  });
});
