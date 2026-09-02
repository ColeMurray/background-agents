// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { useWorkspaceAdministration } from "@/hooks/use-workspace-administration";
import { WorkspaceSettings } from "./workspace-settings";

expect.extend(matchers);

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: vi.fn(),
}));
vi.mock("@/hooks/use-workspace-administration", () => ({
  useWorkspaceAdministration: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkspaceSettings", () => {
  it("shows assigned role names to members-only readers", () => {
    vi.mocked(useCurrentUserAuthorization).mockReturnValue({
      authorization: null,
      loading: false,
      error: null,
      hasPermission: (permission) => permission === "workspace.members.read",
    });
    vi.mocked(useWorkspaceAdministration).mockReturnValue({
      members: [
        {
          userId: "11111111111111111111111111111111",
          displayName: "Ada",
          email: "ada@example.com",
          suspendedAt: null,
          role: { id: "role_release", key: null, name: "Release Managers" },
        },
      ],
      roles: [],
      loading: false,
      error: undefined,
      updateMember: vi.fn(),
    });

    render(<WorkspaceSettings />);

    expect(screen.getByText("Release Managers")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("does not offer destructive controls for the sole unsuspended Owner", () => {
    vi.mocked(useCurrentUserAuthorization).mockReturnValue({
      authorization: null,
      loading: false,
      error: null,
      hasPermission: (permission) =>
        permission === "workspace.members.read" ||
        permission === "workspace.roles.read" ||
        permission === "workspace.members.manage" ||
        permission === "workspace.transfer_ownership",
    });
    vi.mocked(useWorkspaceAdministration).mockReturnValue({
      members: [
        {
          userId: "11111111111111111111111111111111",
          displayName: "Owner",
          email: "owner@example.com",
          suspendedAt: null,
          role: { id: "role_builtin_owner", key: "owner", name: "Owner" },
        },
      ],
      roles: [
        {
          id: "role_builtin_owner",
          key: "owner",
          name: "Owner",
          description: null,
          permissions: [],
          assignmentCount: 1,
        },
      ],
      loading: false,
      error: undefined,
      updateMember: vi.fn(),
    });

    render(<WorkspaceSettings />);

    expect(screen.getAllByText("Owner").length).toBeGreaterThan(0);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Suspend" })).toBeDisabled();
  });

  it("restores a suspended member through the boolean status contract", async () => {
    const updateMember = vi.fn().mockResolvedValue(undefined);
    const member = {
      userId: "11111111111111111111111111111111",
      displayName: "Ada",
      email: "ada@example.com",
      suspendedAt: 100,
      role: { id: "role_builtin_member", key: "member" as const, name: "Member" },
    };
    vi.mocked(useCurrentUserAuthorization).mockReturnValue({
      authorization: null,
      loading: false,
      error: null,
      hasPermission: (permission) =>
        permission === "workspace.members.read" || permission === "workspace.members.manage",
    });
    vi.mocked(useWorkspaceAdministration).mockReturnValue({
      members: [member],
      roles: [],
      loading: false,
      error: undefined,
      updateMember,
    });

    render(<WorkspaceSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() =>
      expect(updateMember).toHaveBeenCalledWith(member, { kind: "status", suspended: false })
    );
  });

  it("disables a member's role and status controls while their update is pending", async () => {
    let finishUpdate!: () => void;
    const updateMember = vi.fn(() => new Promise<void>((resolve) => (finishUpdate = resolve)));
    const member = {
      userId: "11111111111111111111111111111111",
      displayName: "Ada",
      email: "ada@example.com",
      suspendedAt: null,
      role: { id: "role_builtin_member", key: "member" as const, name: "Member" },
    };
    vi.mocked(useCurrentUserAuthorization).mockReturnValue({
      authorization: null,
      loading: false,
      error: null,
      hasPermission: (permission) =>
        permission === "workspace.members.read" ||
        permission === "workspace.roles.read" ||
        permission === "workspace.members.manage",
    });
    vi.mocked(useWorkspaceAdministration).mockReturnValue({
      members: [member],
      roles: [
        {
          id: "role_builtin_member",
          key: "member",
          name: "Member",
          description: null,
          permissions: [],
          assignmentCount: 1,
        },
        {
          id: "role_builtin_administrator",
          key: "administrator",
          name: "Administrator",
          description: null,
          permissions: [],
          assignmentCount: 0,
        },
      ],
      loading: false,
      error: undefined,
      updateMember,
    });

    render(<WorkspaceSettings />);
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "role_builtin_administrator" },
    });

    await waitFor(() => expect(screen.getByRole("combobox")).toBeDisabled());
    expect(screen.getByRole("button", { name: "Suspend" })).toBeDisabled();

    finishUpdate();
    await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
  });
});
