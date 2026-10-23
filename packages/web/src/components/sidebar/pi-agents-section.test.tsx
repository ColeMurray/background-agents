// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiAgentsSection } from "./pi-agents-section";

const mocks = vi.hoisted(() => ({ run: vi.fn(), usePiAgents: vi.fn() }));
vi.mock("@/hooks/use-pi-agents", () => ({
  usePiAgents: (...args: unknown[]) => mocks.usePiAgents(...args),
}));

const rootAgentResult = () => ({
  agents: [
    {
      conversationId: 1,
      status: "active",
      queued: 1,
      tasks: [
        {
          id: 7,
          kind: "pi.generate",
          status: "running",
          phase: "request",
          abortRequested: false,
        },
      ],
      usage: {
        usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, total: 14 },
        costUsd: 0.01,
      },
      lastEntryId: 3,
    },
  ],
  error: null,
  isLoading: false,
  isValidating: false,
  run: mocks.run,
  refresh: vi.fn(),
});

const capabilities = {
  read: true,
  collaborate: true,
  lifecycle: true,
  delete: false,
  manageCollaborators: false,
  changeVisibility: false,
  sandboxAccess: false,
  exportTrace: false,
};

describe("PiAgentsSection", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.run.mockResolvedValue({ state: "accepted" });
    mocks.usePiAgents.mockImplementation(rootAgentResult);
  });

  it("leaves model-producing messages to the canonical session composer", () => {
    render(<PiAgentsSection sessionId="session-1" capabilities={capabilities} />);
    expect(screen.getByRole("button", { name: "Primary agent, active" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "Cancel pi.generate task 7" })).toBeEnabled();
    expect(screen.queryByLabelText("Message selected agent")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Follow up now" })).not.toBeInTheDocument();
  });

  it("does not render lifecycle controls for a task-owned child conversation", async () => {
    const user = userEvent.setup();
    mocks.usePiAgents.mockReturnValueOnce({
      agents: [
        {
          conversationId: 2,
          owner: { conversationId: 1, taskId: 7 },
          status: "idle",
          queued: 0,
          tasks: [],
          usage: {
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
            costUsd: 0,
          },
          lastEntryId: 4,
        },
      ],
      error: null,
      isLoading: false,
      isValidating: false,
      refresh: vi.fn(),
      run: mocks.run,
    });
    render(<PiAgentsSection sessionId="session-1" capabilities={capabilities} />);
    expect(screen.queryByRole("button", { name: "Compact" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Handoff" })).not.toBeInTheDocument();
    await user.keyboard("{Tab}");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("requires confirmation before reset", async () => {
    const user = userEvent.setup();
    render(<PiAgentsSection sessionId="session-1" capabilities={capabilities} />);
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByRole("alertdialog")).toHaveAccessibleName("Reset this conversation?");
    await user.click(screen.getByRole("button", { name: "Reset context" }));
    expect(mocks.run).toHaveBeenCalledWith({ action: "reset", conversationId: 1 });
  });
});
