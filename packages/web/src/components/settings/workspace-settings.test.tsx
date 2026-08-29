// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
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
          avatarUrl: null,
          accessStatus: "active",
          authorizationVersion: 1,
          role: { id: "role_release", key: null, name: "Release Managers" },
          createdAt: 1,
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

  it("does not offer destructive controls for the sole active Owner", () => {
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
          avatarUrl: null,
          accessStatus: "active",
          authorizationVersion: 1,
          role: { id: "role_builtin_owner", key: "owner", name: "Owner" },
          createdAt: 1,
        },
      ],
      roles: [
        {
          id: "role_builtin_owner",
          key: "owner",
          name: "Owner",
          description: null,
          isSystem: true,
          revision: 1,
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
});
