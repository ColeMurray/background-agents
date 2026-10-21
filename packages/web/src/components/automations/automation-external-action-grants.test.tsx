// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationExternalActionGrants } from "./automation-external-action-grants";

const mocks = vi.hoisted(() => ({ create: vi.fn(), revoke: vi.fn(), grants: [] as unknown[] }));
vi.mock("@/hooks/use-automation-external-action-grants", () => ({
  useAutomationExternalActionGrants: () => ({
    grants: mocks.grants,
    error: null,
    isLoading: false,
    create: mocks.create,
    revoke: mocks.revoke,
  }),
}));

describe("AutomationExternalActionGrants", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.grants = [
      {
        id: "grant-1",
        automationId: "auto-1",
        executorUserId: "user-1",
        provider: "github",
        action: "comment",
        createdBy: "user-1",
        createdAt: 1_700_000_000_000,
      },
    ];
    mocks.create.mockResolvedValue(undefined);
    mocks.revoke.mockResolvedValue(undefined);
  });

  it("lists the grants the automation holds", () => {
    render(<AutomationExternalActionGrants automationId="auto-1" canManage />);

    expect(screen.getByText("github · comment")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke github comment" })).toBeInTheDocument();
  });

  it("creates a grant from the provider and action fields", async () => {
    const user = userEvent.setup();
    render(<AutomationExternalActionGrants automationId="auto-1" canManage />);

    await user.type(screen.getByLabelText("Provider"), "github");
    await user.type(screen.getByLabelText("Action"), "comment");
    await user.click(screen.getByRole("button", { name: "Allow" }));

    expect(mocks.create).toHaveBeenCalledWith("github", "comment");
  });

  it("keeps the allow button disabled until both fields are filled", async () => {
    const user = userEvent.setup();
    render(<AutomationExternalActionGrants automationId="auto-1" canManage />);

    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
    await user.type(screen.getByLabelText("Provider"), "github");
    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
  });

  it("revokes a grant", async () => {
    const user = userEvent.setup();
    render(<AutomationExternalActionGrants automationId="auto-1" canManage />);

    await user.click(screen.getByRole("button", { name: "Revoke github comment" }));

    expect(mocks.revoke).toHaveBeenCalledWith("grant-1");
  });

  it("reports a refused grant instead of pretending it succeeded", async () => {
    const user = userEvent.setup();
    mocks.create.mockRejectedValue(new Error("Forbidden"));
    render(<AutomationExternalActionGrants automationId="auto-1" canManage />);

    await user.type(screen.getByLabelText("Provider"), "github");
    await user.type(screen.getByLabelText("Action"), "comment");
    await user.click(screen.getByRole("button", { name: "Allow" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Forbidden");
  });

  it("renders nothing for a viewer who cannot manage the automation", () => {
    render(<AutomationExternalActionGrants automationId="auto-1" canManage={false} />);

    expect(screen.queryByText("Unattended publishing")).toBeNull();
  });
});
