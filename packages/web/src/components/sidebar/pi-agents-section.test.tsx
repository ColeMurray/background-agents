// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiAgentsSection } from "./pi-agents-section";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/hooks/use-pi-agents", () => ({
  usePiAgents: () => ({
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
  }),
}));

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
  });

  it("exposes named keyboard controls and restores message focus after sending", async () => {
    const user = userEvent.setup();
    render(<PiAgentsSection sessionId="session-1" capabilities={capabilities} />);
    expect(screen.getByRole("button", { name: "Primary agent, active" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "Cancel pi.generate task 7" })).toBeEnabled();
    const message = screen.getByLabelText("Message selected agent");
    await user.type(message, "focus on accessibility");
    await user.click(screen.getByRole("button", { name: "Follow up now" }));
    expect(mocks.run).toHaveBeenCalledWith({
      action: "follow_up",
      conversationId: 1,
      content: "focus on accessibility",
    });
    expect(message).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Follow-up queued");
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
