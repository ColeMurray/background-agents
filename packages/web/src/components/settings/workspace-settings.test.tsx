// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { useWorkspaceAdministration } from "@/hooks/use-workspace-administration";
import type { EffectiveAuthorization } from "@open-inspect/shared/rbac";
import { WorkspaceSettings } from "./workspace-settings";

expect.extend(matchers);

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: vi.fn(),
}));
vi.mock("@/hooks/use-workspace-administration", () => ({
  useWorkspaceAdministration: vi.fn(),
}));
vi.mock("./sign-in-allowlist-section", () => ({
  SignInAllowlistSection: () => <div data-testid="sign-in-allowlist">Sign-in allowlist</div>,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkspaceSettings", () => {
  it.each([
    ["owner", true, null, true],
    ["administrator", true, null, true],
    ["owner", false, null, false],
    ["owner", true, 1, false],
    ["member", true, null, false],
    ["viewer", true, null, false],
    [null, true, null, false],
  ] as const)(
    "gates the allowlist mount on role %s, permission %s, suspension %s",
    (key, permission, suspendedAt, visible) => {
      const authorization: EffectiveAuthorization = {
        userId: "11111111111111111111111111111111",
        role: { id: key ? `role_builtin_${key}` : "role_custom", key, name: "Owner" },
        suspendedAt,
        permissions: permission ? ["workspace.members.manage"] : [],
      };
      vi.mocked(useCurrentUserAuthorization).mockReturnValue({
        authorization,
        loading: false,
        error: null,
        hasPermission: (id) =>
          id === "workspace.members.read" || (permission && id === "workspace.members.manage"),
      });
      vi.mocked(useWorkspaceAdministration).mockReturnValue({
        members: [],
        roles: [],
        loading: false,
        error: undefined,
        refreshError: undefined,
        updateMember: vi.fn(),
        previewMerge: vi.fn(),
        mergeMembers: vi.fn(),
      });
      render(<WorkspaceSettings />);
      expect(screen.queryAllByTestId("sign-in-allowlist")).toHaveLength(visible ? 1 : 0);
      expect(screen.getByRole("heading", { name: "Members" })).toBeInTheDocument();
    }
  );

  it("offers account merging only with the merge permission", () => {
    const administration = {
      members: ["11111111111111111111111111111111", "22222222222222222222222222222222"].map(
        (userId) => ({
          userId,
          displayName: null,
          email: null,
          suspendedAt: null,
          role: { id: "role_builtin_member", key: "member" as const, name: "Member" },
        })
      ),
      roles: [],
      loading: false,
      error: undefined,
      refreshError: undefined,
      updateMember: vi.fn(),
      previewMerge: vi.fn(),
      mergeMembers: vi.fn(),
    };
    vi.mocked(useWorkspaceAdministration).mockReturnValue(administration);
    for (const canMerge of [false, true]) {
      vi.mocked(useCurrentUserAuthorization).mockReturnValue({
        authorization: null,
        loading: false,
        error: null,
        hasPermission: (permission) =>
          permission === "workspace.members.read" ||
          (canMerge && permission === "workspace.members.merge"),
      });

      render(<WorkspaceSettings />);

      expect(screen.queryAllByRole("button", { name: "Merge accounts" })).toHaveLength(
        canMerge ? 1 : 0
      );
      cleanup();
    }
  });

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
      refreshError: undefined,
      updateMember: vi.fn(),
      previewMerge: vi.fn(),
      mergeMembers: vi.fn(),
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
      refreshError: undefined,
      updateMember: vi.fn(),
      previewMerge: vi.fn(),
      mergeMembers: vi.fn(),
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
      refreshError: undefined,
      updateMember,
      previewMerge: vi.fn(),
      mergeMembers: vi.fn(),
    });

    render(<WorkspaceSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() =>
      expect(updateMember).toHaveBeenCalledWith(member, { kind: "status", suspended: false })
    );
  });

  it("disables a member's role and status controls while their update is pending", async () => {
    const user = userEvent.setup();
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
      refreshError: undefined,
      updateMember,
      previewMerge: vi.fn(),
      mergeMembers: vi.fn(),
    });

    render(<WorkspaceSettings />);
    await user.click(screen.getByRole("combobox", { name: "Role for Ada" }));
    await user.click(await screen.findByRole("option", { name: "Administrator" }));

    expect(updateMember).toHaveBeenCalledWith(member, {
      kind: "role",
      roleId: "role_builtin_administrator",
    });
    await waitFor(() => expect(screen.getByRole("combobox")).toBeDisabled());
    expect(screen.getByRole("button", { name: "Suspend" })).toBeDisabled();

    finishUpdate();
    await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
  });
});
