// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalActionsSection } from "./external-actions-section";

const mocks = vi.hoisted(() => ({
  decide: vi.fn(),
  hasPermission: vi.fn(),
  actions: [] as unknown[],
}));
vi.mock("@/hooks/use-session-external-actions", () => ({
  useSessionExternalActions: () => ({
    actions: mocks.actions ?? [],
    nextCursor: null,
    error: null,
    isLoading: false,
    decide: mocks.decide,
    refresh: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({ hasPermission: mocks.hasPermission }),
}));

const pending = {
  id: "action-1",
  provider: "github",
  action: "comment",
  summary: "Comment on issue 12",
  state: "awaiting_approval" as const,
  target: { owner: "acme", repo: "widgets", issue: 12 },
  arguments: { body: "hello" },
  approval: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  expiresAt: 1_700_086_400_000,
};

describe("ExternalActionsSection", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.hasPermission.mockReturnValue(true);
    mocks.decide.mockResolvedValue(undefined);
    mocks.actions = [pending];
  });

  it("shows the pending effect with its target and arguments", () => {
    render(<ExternalActionsSection sessionId="session-1" enabled />);

    expect(screen.getByText("Comment on issue 12")).toBeInTheDocument();
    expect(screen.getByText(/owner: acme/)).toBeInTheDocument();
    expect(screen.getByText(/hello/)).toBeInTheDocument();
  });

  it("offers named approve, deny, and cancel controls to an approver", async () => {
    const user = userEvent.setup();
    render(<ExternalActionsSection sessionId="session-1" enabled />);

    await user.click(screen.getByRole("button", { name: "Approve Comment on issue 12" }));
    expect(mocks.decide).toHaveBeenCalledWith("action-1", "approve");

    await user.click(screen.getByRole("button", { name: "Deny Comment on issue 12" }));
    expect(mocks.decide).toHaveBeenCalledWith("action-1", "deny");

    await user.click(screen.getByRole("button", { name: "Cancel Comment on issue 12" }));
    expect(mocks.decide).toHaveBeenCalledWith("action-1", "cancel");
  });

  it("hides the decision controls from a user who cannot approve", () => {
    mocks.hasPermission.mockReturnValue(false);
    render(<ExternalActionsSection sessionId="session-1" enabled />);

    expect(screen.queryByRole("button", { name: "Approve Comment on issue 12" })).toBeNull();
    expect(screen.getByText("Comment on issue 12")).toBeInTheDocument();
  });

  it("reports a refused decision instead of pretending it succeeded", async () => {
    const user = userEvent.setup();
    mocks.decide.mockRejectedValue(new Error("Forbidden"));
    render(<ExternalActionsSection sessionId="session-1" enabled />);

    await user.click(screen.getByRole("button", { name: "Approve Comment on issue 12" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Forbidden");
  });

  it("renders nothing when the deployment disables external actions", () => {
    render(<ExternalActionsSection sessionId="session-1" enabled={false} />);

    expect(screen.queryByText("Comment on issue 12")).toBeNull();
  });

  it("says so when no effect is waiting", () => {
    mocks.actions = [];
    render(<ExternalActionsSection sessionId="session-1" enabled />);

    expect(screen.getByText("No external effects are waiting.")).toBeInTheDocument();
  });
});
