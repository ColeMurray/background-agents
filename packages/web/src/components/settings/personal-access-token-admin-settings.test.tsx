// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type {
  PersonalAccessTokenPolicySnapshot,
  WorkspacePersonalAccessToken,
} from "@open-inspect/shared/types/personal-access-tokens";
import { PersonalAccessTokenAdminSettings } from "./personal-access-token-admin-settings";

const hooks = vi.hoisted(() => ({
  policy: null as PersonalAccessTokenPolicySnapshot | null,
  tokens: [] as WorkspacePersonalAccessToken[],
  mutatePolicy: vi.fn(),
  mutateTokens: vi.fn(),
  save: vi.fn(),
  revokeToken: vi.fn(),
  revokeMember: vi.fn(),
}));

vi.mock("@/hooks/use-workspace-personal-access-tokens", () => ({
  useWorkspacePersonalAccessTokenPolicy: () => ({
    policy: hooks.policy,
    loading: false,
    error: undefined,
    mutate: hooks.mutatePolicy,
  }),
  useWorkspacePersonalAccessTokens: () => ({
    tokens: hooks.tokens,
    hasMore: false,
    loadMore: vi.fn(),
    loading: false,
    error: undefined,
    mutate: hooks.mutateTokens,
  }),
  saveWorkspacePersonalAccessTokenPolicy: hooks.save,
  revokeWorkspacePersonalAccessToken: hooks.revokeToken,
  revokeMemberPersonalAccessTokens: hooks.revokeMember,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

expect.extend(matchers);
afterEach(cleanup);
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_POLICY: PersonalAccessTokenPolicySnapshot = {
  enabled: true,
  maxLifetimeDays: null,
  allowedPermissions: null,
  revision: 3,
  updatedAt: null,
  updatedByUserId: null,
};
const MEMBER_TOKEN: WorkspacePersonalAccessToken = {
  id: "token-1",
  name: "CI reader",
  displayPrefix: "oi_pat_a1b2c3",
  permissions: ["sessions.read"],
  createdAt: Date.now() - DAY_MS,
  lastUsedAt: null,
  expiresAt: Date.now() + 29 * DAY_MS,
  owner: { userId: "user-2", displayName: "Ada Member", email: "ada@example.com" },
};

describe("PersonalAccessTokenAdminSettings", () => {
  beforeEach(() => {
    hooks.policy = OPEN_POLICY;
    hooks.tokens = [];
    for (const mock of [
      hooks.mutatePolicy,
      hooks.mutateTokens,
      hooks.save,
      hooks.revokeToken,
      hooks.revokeMember,
    ])
      mock.mockReset();
  });

  it("saves a kill switch, lifetime cap, and permission ceiling against the loaded revision", async () => {
    hooks.save.mockResolvedValue({ ...OPEN_POLICY, revision: 4 });
    const user = userEvent.setup();
    render(<PersonalAccessTokenAdminSettings />);

    const save = screen.getByRole("button", { name: "Save policy" });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole("switch", { name: "Allow personal access tokens" }));
    await user.click(screen.getByRole("radio", { name: /30 days/ }));
    await user.click(screen.getByRole("radio", { name: /Only those selected/ }));
    // Every grantable permission starts selected; narrow the ceiling to reads of sessions.
    for (const checkbox of screen.getAllByRole("checkbox")) {
      if (checkbox.getAttribute("aria-checked") === "true") await user.click(checkbox);
    }
    await user.click(screen.getByLabelText("Read sessions"));
    await user.click(save);

    expect(hooks.save).toHaveBeenCalledWith(
      { enabled: false, maxLifetimeDays: 30, allowedPermissions: ["sessions.read"] },
      3
    );
  });

  it("refuses an empty permission ceiling", async () => {
    const user = userEvent.setup();
    render(<PersonalAccessTokenAdminSettings />);
    await user.click(screen.getByRole("radio", { name: /Only those selected/ }));
    for (const checkbox of screen.getAllByRole("checkbox")) {
      if (checkbox.getAttribute("aria-checked") === "true") await user.click(checkbox);
    }
    await user.click(screen.getByRole("button", { name: "Save policy" }));
    expect(hooks.save).not.toHaveBeenCalled();
  });

  it("lists members' tokens with their owners and revokes one after confirmation", async () => {
    hooks.tokens = [MEMBER_TOKEN];
    hooks.revokeToken.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<PersonalAccessTokenAdminSettings />);

    const list = within(screen.getByRole("list", { name: "Members' access tokens" }));
    expect(list.getByText("CI reader")).toBeInTheDocument();
    expect(list.getByText(/^Ada Member · Never used/)).toBeInTheDocument();
    await user.click(list.getByRole("button", { name: "Revoke CI reader of Ada Member" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke" })
    );

    await waitFor(() => expect(hooks.revokeToken).toHaveBeenCalledWith("token-1"));
    expect(hooks.mutateTokens).toHaveBeenCalled();
  });

  it("revokes all of a member's tokens after confirmation", async () => {
    hooks.tokens = [MEMBER_TOKEN];
    hooks.revokeMember.mockResolvedValue(2);
    const user = userEvent.setup();
    render(<PersonalAccessTokenAdminSettings />);

    await user.click(screen.getByRole("button", { name: "Revoke all of Ada Member's tokens" }));
    expect(
      within(screen.getByRole("alertdialog")).getByText(/Every token Ada Member holds/)
    ).toBeInTheDocument();
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke" })
    );

    await waitFor(() => expect(hooks.revokeMember).toHaveBeenCalledWith("user-2"));
  });
});
